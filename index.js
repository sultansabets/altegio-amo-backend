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

// enum_id
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
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
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

async function setSyncStatus(rowIndex, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!L${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

async function processPayments() {
  console.log("=== PROCESS PAYMENTS START ===");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });

  const rows = res.data.values || [];
  console.log("Rows from sheet:", rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRowIndex = i + 2;

    const phoneRaw = row[1];        // B
    const paymentType = row[5];     // F
    const amount = row[6];          // G
    const paymentDateRaw = row[9];  // J
    const syncStatus = row[11];     // L

    if (syncStatus) continue; // 🔥 уже обработано
    if (!phoneRaw || !paymentType || !amount) continue;

    try {
      const phone = phoneRaw.replace(/\D/g, "");
      console.log("Processing phone:", phone);

      /* 1. Контакт */
      const contacts = await amo.get("/contacts", {
        params: { query: phone, with: "leads" },
      });

      const contact = contacts.data._embedded?.contacts?.[0];
      if (!contact) {
        console.log("Contact not found");
        await setSyncStatus(sheetRowIndex, "not_found");
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
        console.log("Lead not found in pipeline");
        await setSyncStatus(sheetRowIndex, "not_found");
        continue;
      }

      /* 3. Поля */
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

      console.log(`✅ Lead ${targetLead.id} updated`);
      await setSyncStatus(sheetRowIndex, "processed");
    } catch (e) {
      console.error("Row error:", e.response?.data || e.message);
      await setSyncStatus(sheetRowIndex, "error");
    }
  }

  console.log("=== PROCESS PAYMENTS END ===");
}

/* ================= CRON ================= */

cron.schedule("*/5 * * * *", () => {
  console.log("CRON START");
  processPayments();
});

/* ================= SERVER ================= */

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on", PORT));
