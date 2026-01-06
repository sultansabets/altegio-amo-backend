import express from "express";
import cron from "node-cron";
import axios from "axios";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 10000;

/* ================= НАСТРОЙКИ ================= */

// amoCRM
const AMO_DOMAIN = "clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_TOKEN;

// ВОРОНКА
const PIPELINE_ID = 9884630;

// ЭТАПЫ
const STATUS_PREPAY = 81391378; // Записан / ПРЕДОПЛАТА ПОЛУЧЕНА
const STATUS_FULL = 79666150;   // ПОЛНОСТЬЮ ОПЛАТИЛ

// ПОЛЯ amoCRM
const FIELD_PREPAY_SUM = 1026233;
const FIELD_FULL_SUM = 1077301;
const FIELD_PAYMENT_TYPE = 1077303;
const FIELD_PAYMENT_DATE = 1077305;

// значения select
const PAYMENT_ENUM = {
  prepayment: 837451,
  full: 837453,
};

// Google Sheets
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Payments";

// Google Auth
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/* ================= ВСПОМОГАТЕЛЬНЫЕ ================= */

const amo = axios.create({
  baseURL: `https://${AMO_DOMAIN}/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json",
  },
});

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ================= ОСНОВНАЯ ЛОГИКА ================= */

async function processPayments() {
  log("=== PROCESS PAYMENTS START ===");

  // 1. ЧИТАЕМ GOOGLE SHEETS
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });

  const rows = res.data.values || [];
  log("Rows from sheet:", rows.length);

  if (rows.length === 0) {
    log("No rows found, exit");
    return;
  }

  for (const row of rows) {
    const [
      event_id,
      phone,
      client_name,
      booking_id,
      service_name,
      payment_type,
      payment_amount,
      payment_method,
      payment_status,
      payment_datetime,
      amo_lead_id,
      sync_status,
    ] = row;

    log("Processing phone:", phone);

    if (!phone || sync_status === "done") {
      log("Skip row (no phone or already synced)");
      continue;
    }

    // 2. ИЩЕМ КОНТАКТ ПО ТЕЛЕФОНУ
    const contactResp = await amo.get("/contacts", {
      params: {
        query: phone,
        with: "leads",
      },
    });

    const contacts = contactResp.data?._embedded?.contacts || [];
    if (contacts.length === 0) {
      log("No contact found for phone", phone);
      continue;
    }

    const contact = contacts[0];
    log("Matched contact ID:", contact.id);

    // 3. ИЩЕМ СДЕЛКУ В НУЖНОЙ ВОРОНКЕ
    const leads = contact._embedded?.leads || [];
    const targetLead = leads.find(
      (l) => l.pipeline_id === PIPELINE_ID
    );

    if (!targetLead) {
      log("No lead in target pipeline for phone", phone);
      continue;
    }

    log("Target lead ID:", targetLead.id);

    // 4. ФОРМИРУЕМ ОБНОВЛЕНИЕ
    const custom_fields_values = [];

    if (payment_type === "prepayment") {
      custom_fields_values.push({
        field_id: FIELD_PREPAY_SUM,
        values: [{ value: Number(payment_amount) }],
      });
    }

    if (payment_type === "full") {
      custom_fields_values.push({
        field_id: FIELD_FULL_SUM,
        values: [{ value: Number(payment_amount) }],
      });
    }

    custom_fields_values.push({
      field_id: FIELD_PAYMENT_TYPE,
      values: [{ enum_id: PAYMENT_ENUM[payment_type] }],
    });

    custom_fields_values.push({
      field_id: FIELD_PAYMENT_DATE,
      values: [{ value: payment_datetime }],
    });

    const status_id =
      payment_type === "prepayment" ? STATUS_PREPAY : STATUS_FULL;

    log("Updating lead with:", {
      lead_id: targetLead.id,
      status_id,
      custom_fields_values,
    });

    // 5. ОБНОВЛЯЕМ СДЕЛКУ
    await amo.patch("/leads", [
      {
        id: targetLead.id,
        status_id,
        custom_fields_values,
      },
    ]);

    log("Lead updated correctly:", targetLead.id);

    // 6. ПОМЕЧАЕМ В SHEETS
    const rowIndex = rows.indexOf(row) + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!L${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["done"]],
      },
    });

    log("Row marked as done:", rowIndex);
  }

  log("=== PROCESS PAYMENTS END ===");
}

/* ================= CRON ================= */

cron.schedule("*/5 * * * *", async () => {
  try {
    log("CRON START");
    await processPayments();
  } catch (e) {
    console.error("CRON ERROR:", e?.response?.data || e.message);
  }
});

/* ================= SERVER ================= */

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
