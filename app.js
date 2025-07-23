const express = require("express");
const Airtable = require("airtable");
const _ = require("lodash");
const cors = require("cors");
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());

// --- FUNKCJE POMOCNICZE ---
function fullSku(product, productExtension, material, hasFlatSeams) {
  return `${product?.sku || ""}${productExtension ? productExtension.code : "0"}${
    material ? material.code : ""
  }${hasFlatSeams ? "1" : "0"}`;
}

function orderProductAmount(order, orderProduct) {
  if (!order || !orderProduct) return 0;
  if (order.isReservation) {
    return orderProduct.amount ?? 0;
  } else {
    return (orderProduct.orderProductCustomizations || []).reduce(
      (acc, customization) => acc + (customization.amount || 0),
      0
    );
  }
}
// --- KONIEC FUNKCJI ---

Airtable.configure({ apiKey: process.env.AIRTABLE_TOKEN });
const base = Airtable.base("appG8CkMDHD5Rq2nQ");

// Usuń produkt zamówienia z Airtable
app.post("/api/deleteOrderProduct", async (req, res) => {
  const { airtableUrl } = req.body;
  if (!airtableUrl) return res.status(400).json({ error: "Brak airtableUrl" });

  try {
    await base("Orders").destroy(airtableUrl.split("/")[5]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Usuń całe zamówienie i powiązane produkty z Airtable
app.post("/api/deleteOrder", async (req, res) => {
  const { order } = req.body;
  if (!order) return res.status(400).json({ error: "Brak order" });

  try {
    for (const orderProduct of order.orderProducts || []) {
      const formula = `{zamowienie} = '${order.name}-${orderProduct.name}'`;
      const products = await base("Products")
        .select({ filterByFormula: formula })
        .firstPage();

      for (const product of products) {
        await base("Products").destroy(product.id);
      }
    }

    for (const orderProduct of order.orderProducts || []) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const children = await base("Orders")
        .select({ filterByFormula: `{zamowienie} = "${orderProductName}"` })
        .firstPage();

      for (const child of children) {
        await base("Orders").destroy(child.id);
      }
    }

    const main = await base("Zlecenia bez podziału")
      .select({ filterByFormula: `{Zamówienie} = "${order.name}"` })
      .firstPage();

    for (const record of main) {
      await base("Zlecenia bez podziału").destroy(record.id);
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dodaj zamówienie z produktami do Airtable
app.post("/api/addOrderWithProducts", async (req, res) => {
  const { order, clientId } = req.body;
  if (!order) return res.status(400).json({ error: "Brak order" });

  try {
    // Zamówienie główne
    const existingMain = await base("Zlecenia bez podziału")
      .select({
        filterByFormula: `FIND("${order.name}", {Zamówienie})`,
      })
      .firstPage();
    let orderMainId;

    const klientField = order.clientId?.trim() ? [order.clientId.trim()] : undefined;
    const kontaktyField = order.contactPersonId ? [order.contactPersonId] : undefined;

    if (existingMain.length > 0 && existingMain[0]?.id) {
      orderMainId = existingMain[0].id;
      await base("Zlecenia bez podziału").update(orderMainId, {
        "Zamówienie": order.name,
        Klient: klientField,
        Kontakty: kontaktyField,
        "Opis": order.opis || "",
      });
    } else {
      const orderMain = await base("Zlecenia bez podziału").create({
        "Zamówienie": order.name,
        Klient: klientField,
        Kontakty: kontaktyField,
        "Opis": order.opis || "",
      });
      orderMainId = orderMain.id;
    }

    const firstOrderProductName = (order.orderProducts || [])
      .map((p) => p.name)
      .sort()[0];

    // Usuń stare podzamówienia i produkty
    const oldChildren = await base("Orders")
      .select({
        filterByFormula: `FIND("${order.name}", {Zlecenia bez podziału})`,
      })
      .firstPage();
    const oldChildrenNames = oldChildren.map((child) => child.get("zamowienie"));


    for (const child of oldChildren) {
      if (child?.id) {
        await base("Orders").destroy(child.id);
      }
    }

    // Tworzenie podzamówień i produktów
    for (const orderProduct of order.orderProducts || []) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const orderAddedDate = order.createdAt?.slice
        ? order.createdAt.slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      const netPrice =
        orderProduct.name === firstOrderProductName
          ? order.netPrice?.toString()
          : "0";

      const amount = orderProductAmount(order, orderProduct);

      const existingChild = await base("Orders")
        .select({ filterByFormula: `{zamowienie} = "${orderProductName}"` })
        .firstPage();

      let airtableOrderId;

      if (existingChild.length > 0 && existingChild[0]?.id) {
        await base("Orders").update(existingChild[0].id, {
          zamowienie: orderProductName,
          SKU: fullSku(
            orderProduct.product,
            orderProduct.extension,
            orderProduct.material,
            orderProduct.hasFlatSeams
          ),
          Typ_zamowienia: "Custom",
          Źródło: order.source,
          "Data dodania zamowienia": orderAddedDate,
          "Data do wysyłki": order.sendDate?.slice(0, 10),
          Tryb:
            order.priority == "normal"
              ? "NORMALNY"
              : order.priority == "express"
              ? "EKSPRES"
              : "SUPEREKSPRES",
          Klient: order.clientName,
          "Wartość zamówienia netto": Number(netPrice),
          Komentarz: order.staffComment || "",
          Ilość: amount || 1,
          autor_zlecenia: order.userId,
          domówienie: order.isfollowing || false,
          visualization_url: orderProduct.visualUrl || "",
          order_product_id: orderProduct.id,
          "Kolor nici": orderProduct.strand?.name,
          Dodatki: orderProduct.extension?.name,
          Szwy: orderProduct.hasFlatSeams ? "Płaskie" : "Zwykłe",
          Material: orderProduct.material?.name,
          Metka: order.label,
          "Metka_new": [order.label], 
          Żakardy: order.jacquard,
          customLabelUrl: order.customLabelUrl,
          autor_plikow: order.designer,
          "Zakceptowana wizualizacja": orderProduct.visualName,
          "Email kontaktowy": order.contactPersonEmail || "",
          "Osoba kontaktowa": "",
          "Komentarz obsługi klienta": orderProduct.salesComment || "",
          "Komentarz grafika": orderProduct.designerComment || "",
          clientId: clientId,
          "Zlecenia bez podziału": [orderMainId],
        });
        airtableOrderId = existingChild[0].id;
      } else {
        const createdOrder = await base("Orders").create({
          zamowienie: orderProductName,
          SKU: fullSku(
            orderProduct.product,
            orderProduct.extension,
            orderProduct.material,
            orderProduct.hasFlatSeams
          ),
          Typ_zamowienia: "Custom",
          Źródło: order.source,
          "Data dodania zamowienia": orderAddedDate,
          "Data do wysyłki": order.sendDate?.slice(0, 10),
          Tryb:
            order.priority == "normal"
              ? "NORMALNY"
              : order.priority == "express"
              ? "EKSPRES"
              : "SUPEREKSPRES",
          Klient: order.clientName,
          "Wartość zamówienia netto": Number(netPrice),
          Komentarz: order.staffComment || "",
          Ilość: amount || 1,
          autor_zlecenia: order.userId,
          domówienie: order.isfollowing || false,
          visualization_url: orderProduct.visualUrl || "",
          order_product_id: orderProduct.id,
          "Kolor nici": orderProduct.strand?.name,
          Dodatki: orderProduct.extension?.name,
          Szwy: orderProduct.hasFlatSeams ? "Płaskie" : "Zwykłe",
          Material: orderProduct.material?.name,
          Metka: order.label,
          "Metka_new": [order.label], 
          Żakardy: order.jacquard,
          customLabelUrl: order.customLabelUrl,
          autor_plikow: order.designer,
          "Zakceptowana wizualizacja": orderProduct.visualName,
          "Email kontaktowy": order.contactPersonEmail || "",
          "Osoba kontaktowa": "",
          "Komentarz obsługi klienta": orderProduct.salesComment || "",
          "Komentarz grafika": orderProduct.designerComment || "",
          clientId: clientId,
          "Zlecenia bez podziału": [orderMainId],
        });
        airtableOrderId = createdOrder.id;
      }

      // Dodaj personalizacje (customizations) do Products
      if (airtableOrderId && orderProduct.orderProductCustomizations) {
        const toCreate = orderProduct.orderProductCustomizations.map(
          (customization) => ({
            fields: {
              zamowienie: airtableOrderId ? [airtableOrderId] : [],
              Nazwa: orderProduct.product?.name || "",
              ilosc: customization.amount || 0,
              rozmiar: customization.size || "",
              plec:
                customization.type == "male"
                  ? "Męska"
                  : customization.type == "female"
                  ? "Damska"
                  : "Kids",
              SKU: fullSku(
                orderProduct.product,
                orderProduct.extension,
                orderProduct.material,
                orderProduct.hasFlatSeams
              ),
              personalizacja: customization.customization || "",
              "dodatkowe info 1": customization.number || "",
              "X produktu": orderProduct.extension
                ? orderProduct.extension.xValue * (customization.amount || 1)
                : orderProduct.product?.xValue * (customization.amount || 1),
            },
          })
        );
        for (const chunk of _.chunk(toCreate, 10)) {
          await base("Products").create(chunk);
        }
      }
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dodaj rezerwację do Airtable
app.post("/api/addReservation", async (req, res) => {
  const { order, clientId } = req.body;
  if (!order) return res.status(400).json({ error: "Brak order" });

  try {
    const existingMain = await base("Zlecenia bez podziału")
      .select({ filterByFormula: `{Zamówienie} = "${order.name}"` })
      .firstPage();

    let reservationMainId;
    const klientField = order.clientId?.trim() ? [order.clientId.trim()] : undefined;

    if (existingMain.length > 0 && existingMain[0]?.id) {
      reservationMainId = existingMain[0].id;
      await base("Zlecenia bez podziału").update(reservationMainId, {
        "Zamówienie": order.name,
        Klient: klientField,
        "Opis": order.opis || "",
      });
    } else {
      const reservationMain = await base("Zlecenia bez podziału").create({
        "Zamówienie": order.name,
        Klient: klientField,
        "Opis": order.opis || "",
      });
      reservationMainId = reservationMain.id;
    }

    const addedDates = {};

    for (const orderProduct of order.orderProducts || []) {
      if (orderProduct.airtableUrl) {
        const orderProductAirtableId = orderProduct.airtableUrl.split("/")[5];
        if (orderProductAirtableId) {
          const airtableOrderProduct = await base("Orders").find(
            orderProductAirtableId
          );
          const orderProductName =
            airtableOrderProduct.get("zamowienie")?.toString() || "";

          addedDates[orderProductName] = airtableOrderProduct.get(
            "Data dodania zamowienia"
          );

          await base("Orders").destroy(orderProduct.airtableUrl.split("/")[5]);
        }
      }
    }

    for (const orderProduct of order.orderProducts || []) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const orderAddedDate =
        addedDates[orderProductName] || new Date().toISOString().slice(0, 10);

      const amount = orderProductAmount(order, orderProduct);

      await base("Orders")
        .create({
          zamowienie: orderProductName,
          SKU: fullSku(
            orderProduct.product,
            orderProduct.extension,
            orderProduct.material,
            orderProduct.hasFlatSeams
          ),
          Typ_zamowienia: "Custom",
          Źródło: order.source,
          "Data dodania zamowienia": orderAddedDate,
          "Data do wysyłki": order.sendDate?.slice(0, 10),
          Klient: order.clientName,
          Komentarz: order.staffComment || "",
          Ilość: amount || 1,
          autor_zlecenia: order.userId,
          order_product_id: orderProduct.id,
          Dodatki: orderProduct.extension?.name,
          Material: orderProduct.material?.name,
          "Email kontaktowy": order.contactPersonEmail || "",
          "Osoba kontaktowa": "",
          "Komentarz obsługi klienta": orderProduct.salesComment || "",
          "Komentarz grafika": orderProduct.designerComment || "",
          "Zlecenia bez podziału": [reservationMainId],
        })
        .then(async (airtableOrder) => {
          await base("Products").create({
            zamowienie: [airtableOrder.getId()],
            Nazwa: orderProduct.product?.name || "",
            ilosc: amount || 1,
            rozmiar: "rezerwacja",
            plec: "rezerwacja",
            SKU: fullSku(
              orderProduct.product,
              orderProduct.extension,
              orderProduct.material,
              orderProduct.hasFlatSeams
            ),
            "X produktu": orderProduct.extension
              ? orderProduct.extension.xValue * (amount || 1)
              : orderProduct.product?.xValue * (amount || 1),
          });
        });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h1>Railway Airtable API</h1>
    <p>Projekt działa! Data builda: ${new Date().toLocaleString()}</p>
    <p>Endpointy: <a href="/api/addOrderWithProducts">/api/addOrderWithProducts</a> itd.</p>
  `);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Railway Airtable API running!");
});

// app.js na Railway - DODAJ TE ENDPOINTY

// Endpoint do parsowania tekstu
app.post('/api/parse-text', async (req, res) => {
  console.log('Railway: parse-text called');
  
  try {
    const { text, products } = req.body;
    
    if (!text || typeof text !== "string" || !Array.isArray(products)) {
      return res.status(400).json({ error: "Brak tekstu wejściowego lub produktów." });
    }

    const productsSection = buildProductsSection(products);
    
    const prompt = `
Otrzymasz tekst z zamówieniem na produkty (np. koszulki, bluzy, inne). Każdy produkt, którego dotyczy zamówienie, jest opisany poniżej – każdemu przypisana jest literka oraz nazwa produktu. W tekście klienta może być użyta zarówno literka, jak i pełna nazwa produktu.

Wyodrębnij z tekstu dane do tabeli o kolumnach:
- personalizacja (może być to imię, nick, pseudonim itp.)
- rozmiar (w formacie takim jak poniżej)
- płeć (jeśli występuje: MĘSKA, DAMSKA, UNISEX, DZIECIĘCA – jeśli nie ma, spróbuj rozpoznać na podstawie imienia lub kontekstu)
- numer (jeśli występuje)
- podzamówienie (oznaczenie literą, np. a, b, c – lub nazwą produktu, jeśli pojawia się w tekście)
- ilość (jeśli w tekście jest np. "3 x S", wpisz ilość 3; jeśli nie podano ilości, załóż domyślnie 1)

Dostępne podzamówienia i rozmiarówki:
${productsSection}

Jeśli w tekście pojawia się rozmiar typu XXL, XXXL, XXXXL itp., ZAMIENIAJ je odpowiednio na 2XL, 3XL, 4XL, 5XL, 6XL.

Zwróć wynik jako tablicę JSON, np.:
[
  { "personalizacja": "ŁUKASZ", "rozmiar": "2XL", "płeć": "MĘSKA", "numer": null, "podzamówienie": "a", "ilość": 1 }
]

Oto tekst:
"""
${text}
"""
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const content = completion.choices?.[0]?.message?.content;
    const match = content?.match(/\[[\s\S]*\]/);
    
    if (!match) {
      return res.status(400).json({ error: "Brak danych w odpowiedzi OpenAI." });
    }
    
    const data = JSON.parse(match[0]);
    return res.status(200).json({ data });
    
  } catch (error) {
    console.error('Railway parse-text error:', error);
    return res.status(500).json({ error: error.message || "Błąd serwera." });
  }
});

// Endpoint do parsowania obrazu
app.post('/api/parse-image', async (req, res) => {
  console.log('Railway: parse-image called');
  
  try {
    const { imageUrl, products, note } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: "Brak linku do obrazka" });
    }

    const productsSection = buildProductsSection(products);
    
    const prompt = `
Otrzymasz zdjęcie lub zrzut ekranu z zamówieniem na produkty (np. koszulki, bluzy, inne). Każdy produkt, którego dotyczy zamówienie, jest opisany poniżej – każdemu przypisana jest literka oraz nazwa produktu. W tekście klienta może być użyta zarówno literka, jak i pełna nazwa produktu.

${note ? `Dodatkowe informacje od operatora: ${note}\n` : ""}

Wyodrębnij z obrazu dane do tabeli o kolumnach:
- personalizacja (może być to imię, nick, pseudonim itp.)
- rozmiar (w formacie takim jak poniżej)
- płeć (jeśli występuje: MĘSKA, DAMSKA, UNISEX, DZIECIĘCA – jeśli nie ma, spróbuj rozpoznać na podstawie imienia lub kontekstu)
- numer (jeśli występuje)
- podzamówienie (oznaczenie literą, np. a, b, c – lub nazwą produktu, jeśli pojawia się w tekście; przypisz do odpowiedniego produktu zgodnie z opisem poniżej)
- ilość (jeśli w obrazie/tekście jest np. "3 x S", wpisz ilość 3; jeśli nie podano ilości, załóż domyślnie 1)

Dostępne podzamówienia i rozmiarówki:
${productsSection}

Jeśli w tekście pojawia się rozmiar typu XXL, XXXL, XXXXL itp., ZAMIENIAJ je odpowiednio na 2XL, 3XL, 4XL, 5XL, 6XL.

Zwróć wynik jako tablicę JSON, np.:
[
  { "personalizacja": "ŁUKASZ", "rozmiar": "2XL", "płeć": "MĘSKA", "numer": null, "podzamówienie": "a", "ilość": 1 }
]
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    });

    const content = completion.choices[0]?.message?.content || "";
    let data = null;
    
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      data = JSON.parse(match[0]);
    }

    return res.status(200).json({ data });
    
  } catch (error) {
    console.error('Railway parse-image error:', error);
    return res.status(500).json({ error: "Błąd przetwarzania obrazu." });
  }
});

// Funkcja pomocnicza - dodaj na końcu pliku
function buildProductsSection(products) {
  return products
    .map(
      (p, idx) =>
        `Podzamówienie ${String.fromCharCode(97 + idx)} (${p.productName || p.label}):
- SKU: ${p.sku}
${(p.genders || [])
  .map(
    (g) =>
      `- Płeć: ${g.label}, dostępne rozmiary: ${(g.sizes || []).join(", ")}`
  )
  .join("\n")}`
    )
    .join("\n\n");
}