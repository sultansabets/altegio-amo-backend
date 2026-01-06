import express from "express";
import axios from "axios";
import cron from "node-cron";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 10000;

// ================== CONFIG ==================
const AMO_DOMAIN = "clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const PIPELINE_ID = 9884630;
const STATUS_PREPAYMENT = 81391378;
const STATUS_FULLPAYMENT = 79666150;

// ================== GOOGLE ==================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheetsApi = google.sheets({ version: "v4", auth });

// ================== AMO AXIOS ==================
const amo = axios.create({
  baseURL: `https://${AMO_DOMAIN}/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// ================== CORE LOGIC ==================
async function processPayments() {
  console.log("=== PROCESS PAYMENTS START ===");

  const sheet = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A2:E",
  });

  const rows = sheet.data.values || [];
  console.log("Rows from sheet:", rows.length);

  for (const row of rows) {
    const [phone, paymentType, prepay, fullpay, date] = row;
    if (!phone) continue;

    console.log("Processing phone:", phone);

    // 1️⃣ FIND CONTACT
    const contactsRes = await amo.get("/contacts", {
      params: { query: phone },
    });

    const contact = contactsRes.data?._embedded?.contacts?.[0];
    if (!contact) {
      console.log("Contact not found:", phone);
      continue;
    }

    console.log("Matched contact ID:", contact.id);

    // 2️⃣ FIND LEAD IN PIPELINE BY CONTACT
    const leadsRes = await amo.get("/leads", {
      params: {
        "filter[contacts][id]": contact.id,
        "filter[pipeline_id]": PIPELINE_ID,
        "order[created_at]": "desc",
        limit: 1,
      },
    });

    const lead = leadsRes.data?._embedded?.leads?.[0];
    if (!lead) {
      console.log("No lead in pipeline for contact:", contact.id);
      continue;
    }

    console.log("Matched lead ID:", lead.id);

    // 3️⃣ PREPARE FIELDS
    const customFields = [];

    if (prepay) {
      customFields.push({
        field_id: 1026233,
        values: [{ value: Number(prepay) }],
      });
    }

    if (fullpay) {
      customFields.push({
        field_id: 1077301,
        values: [{ value: Number(fullpay) }],
      });
    }

    if (paymentType) {
      customFields.push({
        field_id: 1077303,
        values: [
          {
            enum_id:
              paymentType === "prepayment" ? 837451 : 837453,
          },
        ],
      });
    }

    if (date) {
      customFields.push({
        field_id: 1077305,
        values: [{ value: date }],
      });
    }

    // 4️⃣ UPDATE LEAD + MOVE STAGE
    const targetStatus =
      paymentType === "prepayment"
        ? STATUS_PREPAYMENT
        : paymentType === "full"
        ? STATUS_FULLPAYMENT
        : lead.status_id;

    await amo.patch(`/leads/${lead.id}`, {
      status_id: targetStatus,
      custom_fields_values: customFields,
    });

    console.log("Lead updated:", lead.id);
  }

  console.log("=== PROCESS PAYMENTS END ===");
}

// ================== CRON ==================
cron.schedule("*/5 * * * *", async () => {
  console.log("CRON START");
  try {
    await processPayments();
  } catch (e) {
    console.error("CRON ERROR:", e.response?.data || e.message);
  }
});

// ================== SERVER ==================
app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on", PORT));
