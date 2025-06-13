const express = require("express");
const Airtable = require("airtable");
const _ = require("lodash");

const app = express();
app.use(express.json());

// Skonfiguruj klucz API Airtable z Railway Variables!
Airtable.configure({ apiKey: process.env.AIRTABLE_TOKEN });
const base = Airtable.base("appG8CkMDHD5Rq2nQ");

// Przykładowy endpoint do dodawania zamówienia
app.post("/api/addOrderWithProducts", async (req, res) => {
  const { order, clientId } = req.body;
  try {
    // Tutaj wklej swoją logikę dodawania zamówienia do Airtable
    // Przykład:
    // await base("Orders").create({ fields: { ... } });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dodaj kolejne endpointy według potrzeb...

app.listen(process.env.PORT || 3000, () => {
  console.log("Railway Airtable API running!");
});