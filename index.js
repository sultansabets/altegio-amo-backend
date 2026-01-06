import express from "express";
import axios from "axios";
import cron from "node-cron";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 10000;

/* ===================== НАСТРОЙКИ ===================== */

const AMO_DOMAIN = "https://clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;

const PIPELINE_ID = 9884630;
const STATUS_PREPAY = 81391378;
const STATUS_FULLPAY = 79666150;

// поля amoCRM
const FIELD_PAYMENT_TYPE = 1077303;
const FIELD_PREPAY = 1026233;
const FIELD_FULLPAY = 1077301;
const FIELD_PAYMENT_DATE = 1077305;

// Google Sheets
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Payments";

/* ===================== GOOGLE ===================== */

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

/* ===================== AMO ===================== */

const amo = axios.create({
  baseURL: `${AMO_DOMAIN}/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json",
  },
});

/* ===================== ОСНОВНАЯ ЛОГИКА ===================== */

async function processPayments() {
  console.log("=== PROCESS PAYMENTS START ===");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });

  const rows = res.data.values || [];
  console.log("Rows from sheet:", rows.length);

  for (const row of rows) {
    const phoneRaw = row[1];          // B client_phone
    const paymentType = row[5];       // F payment_type
    const amount = row[6];            // G payment_amount
    const paymentDate = row[9];       // J payment_datetime

    if (!phoneRaw || !paymentType || !amount) continue;

    const phone = phoneRaw.replace(/\D/g, "");
    console.log("Processing phone:", phone);

    // 1. Контакт
    const contacts = await amo.get("/contacts", {
      params: { query: phone, with: "leads" },
    });

    const contact = contacts.data._embedded?.contacts?.[0];
    if (!contact) {
      console.log("No contact for phone", phone);
      continue;
    }

    // 2. Сделка в нужной воронке
    const leads = contact._embedded?.leads || [];
    let targetLead = null;

    for (const l of leads) {
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

    // 3. Подготовка полей
    const customFields = [];

    if (paymentType === "prepayment") {
      customFields.push({
        field_id: FIELD_PREPAY,
        values: [{ value: Number(amount) }],
      });
    }

    if (paymentType === "full") {
      customFields.push({
        field_id: FIELD_FULLPAY,
        values: [{ value: Number(amount) }],
      });
    }

    customFields.push({
      field_id: FIELD_PAYMENT_TYPE,
      values: [{ enum_code: paymentType }],
    });

    if (paymentDate) {
      customFields.push({
        field_id: FIELD_PAYMENT_DATE,
        values: [{ value: paymentDate }],
      });
    }

    // 4. Обновление сделки
    await amo.patch(`/leads/${targetLead.id}`, {
      status_id: paymentType === "prepayment" ? STATUS_PREPAY : STATUS_FULLPAY,
      custom_fields_values: customFields,
    });

    console.log(`✅ Lead ${targetLead.id} updated correctly`);
  }

  console.log("=== PROCESS PAYMENTS END ===");
}

/* ===================== CRON ===================== */

cron.schedule("*/5 * * * *", () => {
  console.log("CRON START");
  processPayments().catch((e) =>
    console.error("CRON ERROR:", e.response?.data || e.message)
  );
});

/* ===================== SERVER ===================== */

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on", PORT));
