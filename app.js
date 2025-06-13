const express = require("express");
const Airtable = require("airtable");
const _ = require("lodash");

const app = express();
app.use(express.json());

Airtable.configure({ apiKey: process.env.AIRTABLE_TOKEN });
const base = Airtable.base("appG8CkMDHD5Rq2nQ");

// Usuń produkt zamówienia z Airtable
app.post("/api/deleteOrderProduct", async (req, res) => {
  const { airtableUrl } = req.body; // Przekazuj airtableUrl produktu!
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
  const { order } = req.body; // Przekazuj cały obiekt zamówienia z orderProducts!
  if (!order) return res.status(400).json({ error: "Brak order" });

  try {
    // 1. Usuń produkty powiązane z podzamówieniami
    for (const orderProduct of order.orderProducts) {
      const formula = `{zamowienie} = '${order.name}-${orderProduct.name}'`;
      const products = await base("Products")
        .select({ filterByFormula: formula })
        .firstPage();

      for (const product of products) {
        await base("Products").destroy(product.id);
      }
    }

    // 2. Usuń podzamówienia z Orders po nazwie
    for (const orderProduct of order.orderProducts) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const children = await base("Orders")
        .select({ filterByFormula: `{zamowienie} = "${orderProductName}"` })
        .firstPage();

      for (const child of children) {
        await base("Orders").destroy(child.id);
      }
    }

    // 3. Usuń zamówienie główne z Airtable po nazwie
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
  const { order, clientId } = req.body; // Przekazuj cały obiekt order!
  if (!order) return res.status(400).json({ error: "Brak order" });

  try {
    // 1. Szukamy zamówienia-matki po numerze zamówienia
    const existingMain = await base("Zlecenia bez podziału")
      .select({
        filterByFormula: `FIND("${order.name}", {Zamówienie})`,
      })
      .firstPage();
    let orderMainId;

    const klientField = order.clientId?.trim() ? [order.clientId.trim()] : undefined;
    const kontaktyField = order.contactPersonId ? [order.contactPersonId] : undefined;

    if (existingMain.length > 0 && existingMain[0]?.id) {
      // Zamówienie już istnieje, aktualizujemy
      orderMainId = existingMain[0].id;
      await base("Zlecenia bez podziału").update(orderMainId, {
        "Zamówienie": order.name,
        Klient: klientField,
        Kontakty: kontaktyField,
        "Opis": order.opis || "",
      });
    } else {
      // Zamówienie nie istnieje, tworzymy nowe
      const orderMain = await base("Zlecenia bez podziału").create({
        "Zamówienie": order.name,
        Klient: klientField,
        Kontakty: kontaktyField,
        "Opis": order.opis || "",
      });
      orderMainId = orderMain.id;
    }

    const firstOrderProductName = order.orderProducts
      .map((p) => p.name)
      .sort()[0];

    // 1. Pobierz wszystkie podzamówienia (Orders) powiązane z tym zamówieniem po NAZWIE
    const oldChildren = await base("Orders")
      .select({
        filterByFormula: `FIND("${order.name}", {Zlecenia bez podziału})`,
      })
      .firstPage();
    // 2. Zbierz ich NAZWY (nie ID!)
    const oldChildrenNames = oldChildren.map((child) => child.get("zamowienie"));

    // 3. Usuń wszystkie produkty powiązane z tymi podzamówieniami po nazwie
    if (oldChildrenNames.length > 0) {
      const formula = `OR(${oldChildrenNames
        .map((name) => `FIND("${name}", {zamowienie})`)
        .join(",")})`;

      const oldProducts = await base("Products")
        .select({ filterByFormula: formula })
        .firstPage();

      for (const product of oldProducts) {
        await base("Products").destroy(product.id);
      }
    }

    // 4. Usuń stare podzamówienia
    for (const child of oldChildren) {
      if (child?.id) {
        await base("Orders").destroy(child.id);
      }
    }

    // 5. Tworzymy zamówienia-córki i linkujemy do matki
    for (const orderProduct of order.orderProducts) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const orderAddedDate = order.createdAt.slice(0, 10);

      const netPrice =
        orderProduct.name === firstOrderProductName
          ? order.netPrice?.toString()
          : "0";

      const existingChild = await base("Orders")
        .select({ filterByFormula: `{zamowienie} = "${orderProductName}"` })
        .firstPage();

      let airtableOrderId;

      // Pomocnicza funkcja do SKU
      const fullSku = (product, extension, material, hasFlatSeams) => {
        // uproszczona wersja, dostosuj do swoich potrzeb!
        return [
          product?.sku,
          extension?.sku,
          material?.sku,
          hasFlatSeams ? "PLASKIE" : "ZWYKLE",
        ]
          .filter(Boolean)
          .join("-");
      };

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
          Ilość: orderProduct.amount || 1,
          autor_zlecenia: order.userId,
          domówienie: order.isfollowing || false,
          visualization_url: orderProduct.visualUrl || "",
          order_product_id: orderProduct.id,
          "Kolor nici": orderProduct.strand?.name,
          Dodatki: orderProduct.extension?.name,
          Szwy: orderProduct.hasFlatSeams ? "Płaskie" : "Zwykłe",
          Material: orderProduct.material?.name,
          Metka: order.label,
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
          Ilość: orderProduct.amount || 1,
          autor_zlecenia: order.userId,
          domówienie: order.isfollowing || false,
          visualization_url: orderProduct.visualUrl || "",
          order_product_id: orderProduct.id,
          "Kolor nici": orderProduct.strand?.name,
          Dodatki: orderProduct.extension?.name,
          Szwy: orderProduct.hasFlatSeams ? "Płaskie" : "Zwykłe",
          Material: orderProduct.material?.name,
          Metka: order.label,
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
              Nazwa: orderProduct.product.name,
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
              "X produktu": !!orderProduct.extension
                ? orderProduct.extension.xValue * (customization.amount || 1)
                : orderProduct.product.xValue * (customization.amount || 1),
            },
          })
        );
        // Airtable pozwala na max 10 rekordów na raz
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
  const { order, clientId } = req.body; // Przekazuj cały obiekt order!
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

    for (const orderProduct of order.orderProducts) {
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

    for (const orderProduct of order.orderProducts) {
      const orderProductName = order.name + "-" + orderProduct.name;
      const orderAddedDate =
        addedDates[orderProductName] || new Date().toISOString().slice(0, 10);

      await base("Orders")
        .create({
          zamowienie: orderProductName,
          SKU: orderProduct.product?.sku || "",
          Typ_zamowienia: "Custom",
          Źródło: order.source,
          "Data dodania zamowienia": orderAddedDate,
          "Data do wysyłki": order.sendDate?.slice(0, 10),
          Klient: order.clientName,
          Komentarz: order.staffComment || "",
          Ilość: orderProduct.amount || 1,
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
            ilosc: orderProduct.amount || 1,
            rozmiar: "rezerwacja",
            plec: "rezerwacja",
            SKU: orderProduct.product?.sku || "",
            "X produktu": !!orderProduct.extension
              ? orderProduct.extension.xValue * (orderProduct.amount || 1)
              : orderProduct.product.xValue * (orderProduct.amount || 1),
          });
        });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Railway Airtable API running!");
});