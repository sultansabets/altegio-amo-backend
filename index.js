import express from "express";
import axios from "axios";
import cron from "node-cron";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 10000;

/* ================= НАСТРОЙКИ ================= */

const AMO_DOMAIN = "https://clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;

const PIPELINE_ID = 9884630;

// статусы
const STATUS_PREPAY = 81391378;
const STATUS_FULLPAY = 79666150;

// поля сделки
const FIELD_PREPAY = 1026233;
const FIELD_FULLPAY = 1077301;
const FIELD_PAYMENT_TYPE = 1077303;
const FIELD_PAYMENT_DATE = 1077305;

// enum_id типов оплаты
const PAYMENT_ENUM = {
  prepayment: 837451,
  full: 837453,
};

// Google Sheets
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Payments";

/* ================= GOOGLE ================= */

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

/* ================= AMO ================= */

const amo = axios.create({
  baseURL: `${AMO_DOMAIN}/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json",
  },
});

/* ================= ЛОГИКА ================= */

async function processPayments() {
  console.log("=== PROCESS PAYMENTS START ===");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });

  const rows = res.data.values || [];
  console.log("Rows from sheet:", rows.length);

  for (const row of rows) {
    const phoneRaw = row[1];        // B client_phone
    const paymentType = row[5];    // F payment_type
    const amount = row[6];         // G payment_amount
    const paymentDateRaw = row[9]; // J payment_datetime

    if (!phoneRaw || !paymentType || !amount) continue;

    const phone = phoneRaw.replace(/\D/g, "");
    console.log("Processing phone:", phone);

    /* 1. Контакт */
    const contacts = await amo.get("/contacts", {
      params: { query: phone, with: "leads" },
    });

    const contact = contacts.data._embedded?.contacts?.[0];
    if (!contact) {
      console.log("No contact for phone", phone);
      continue;
    }

    /* 2. Сделка в нужной воронке */
    let targetLead = null;

    for (const l of contact._embedded?.leads || []) {
      const lead = await amo.get(`/leads/${l.id}`);
      if (lead.data.pipeline_id === PIPELINE_ID) {
        targetLead = lead.data;
        break;
      }
    }

    if (!targetLead) {
      console.log("No lead in target pipeline for phone", phone);
      continue;
    }

    console.log("Target lead:", targetLead.id);

    /* 3. Кастомные поля */
    const fields = [];

    if (paymentType === "prepayment") {
      fields.push({
        field_id: FIELD_PREPAY,
        values: [{ value: Number(amount) }],
      });
    }

    if (paymentType === "full") {
      fields.push({
        field_id: FIELD_FULLPAY,
        values: [{ value: Number(amount) }],
      });
    }

    fields.push({
      field_id: FIELD_PAYMENT_TYPE,
      values: [{ enum_id: PAYMENT_ENUM[paymentType] }],
    });

    if (paymentDateRaw) {
      const ts = Math.floor(new Date(paymentDateRaw).getTime() / 1000);
      fields.push({
        field_id: FIELD_PAYMENT_DATE,
        values: [{ value: ts }],
      });
    }

    /* 4. Обновление сделки */
    await amo.patch(`/leads/${targetLead.id}`, {
      status_id:
        paymentType === "prepayment" ? STATUS_PREPAY : STATUS_FULLPAY,
      custom_fields_values: fields,
    });

    console.log(`✅ Lead ${targetLead.id} updated correctly`);
  }

  console.log("=== PROCESS PAYMENTS END ===");
}

/* ================= CRON ================= */

cron.schedule("*/5 * * * *", () => {
  console.log("CRON START");
  processPayments().catch((e) =>
    console.error("CRON ERROR:", e.response?.data || e.message)
  );
});

/* ================= SERVER ================= */

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on", PORT));
