import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import cron from "node-cron";

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const AMO_DOMAIN = process.env.AMO_DOMAIN; // clinicreformatormen.amocrm.ru
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;

// Google
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "Payments";

// Amo constants
const PIPELINE_ID = 9884630;

const STATUS_PREPAYMENT = 81391378;
const STATUS_FULLPAYMENT = 79666150;

const FIELD_FULL_AMOUNT = 1077301;
const FIELD_PAYMENT_TYPE = 1077303;
const FIELD_PAYMENT_DATE = 1077305;
const FIELD_PREPAY_AMOUNT = 1026233;

const PAYMENT_ENUM = {
  prepayment: 837451,
  full: 837453,
};

// ================== HELPERS ==================
const amoFetch = async (url, method = "GET", body) => {
  const res = await fetch(`https://${AMO_DOMAIN}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${AMO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`amo error ${res.status}: ${text}`);
  }

  return res.json();
};

const normalizePhone = (phone) =>
  phone.replace(/\D/g, "").replace(/^8/, "7");

// ================== GOOGLE ==================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheetsApi = google.sheets({ version: "v4", auth });

// ================== CORE LOGIC ==================
async function processPayments() {
  console.log("CRON START");

  const sheet = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });

  const rows = sheet.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const [
      event_id,
      client_phone,
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
    ] = rows[i];

    if (sync_status !== "new") continue;

    const phone = normalizePhone(client_phone);
    console.log("Processing phone:", phone);

    // 1. Find contact
    const contacts = await amoFetch(
      `/api/v4/contacts?query=${phone}&with=leads`
    );

    const contact = contacts._embedded?.contacts?.[0];
    if (!contact) {
      console.log("No contact found");
      continue;
    }

    // 2. Find lead in target pipeline
    const lead = contact._embedded?.leads?.find(
      (l) => l.pipeline_id === PIPELINE_ID
    );

    if (!lead) {
      console.log("No lead in target pipeline");
      continue;
    }

    console.log("Target lead:", lead.id);

    // 3. Build payload
    const customFields = [
      {
        field_id: FIELD_PAYMENT_TYPE,
        values: [{ enum_id: PAYMENT_ENUM[payment_type] }],
      },
      {
        field_id: FIELD_PAYMENT_DATE,
        values: [{ value: Math.floor(Date.now() / 1000) }],
      },
    ];

    let statusId;

    if (payment_type === "prepayment") {
      statusId = STATUS_PREPAYMENT;
      customFields.push({
        field_id: FIELD_PREPAY_AMOUNT,
        values: [{ value: Number(payment_amount) }],
      });
    } else if (payment_type === "full") {
      statusId = STATUS_FULLPAYMENT;
      customFields.push({
        field_id: FIELD_FULL_AMOUNT,
        values: [{ value: Number(payment_amount) }],
      });
    } else {
      console.log("Unknown payment type");
      continue;
    }

    // 4. Update lead
    await amoFetch(`/api/v4/leads/${lead.id}`, "PATCH", {
      status_id: statusId,
      custom_fields_values: customFields,
    });

    console.log(`Lead ${lead.id} updated correctly`);

    // 5. Mark as done
    rows[i][11] = "done";
  }

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  console.log("CRON FINISH");
}

// ================== CRON ==================
cron.schedule("*/5 * * * *", processPayments);

// ================== HEALTH ==================
app.get("/health", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on", PORT));
