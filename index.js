import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */

const AMO_BASE_URL = "https://clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;

const PIPELINE_ID = 9884630;

const STATUS_PREPAYMENT = 81391378;
const STATUS_FULLPAYMENT = 79666150;

const PREPAYMENT_FIELD_ID = 1026233;
const FULLPAYMENT_FIELD_ID = 1077301;
const PAYMENT_TYPE_FIELD_ID = 1077303;
const PAYMENT_DATE_FIELD_ID = 1077305;

/* ================= HELPERS ================= */

function normalizePhone(phone) {
  return phone.replace(/\D/g, "").replace(/^8/, "7");
}

async function amoRequest(url, method = "GET", body = null) {
  const res = await fetch(`${AMO_BASE_URL}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${AMO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (res.status === 204) return null;
  return res.json();
}

/* ================= CORE ================= */

async function processPayment(row) {
  const phone = normalizePhone(row.client_phone);
  console.log("PHONE:", phone);

  // 1. Find contact
  const contactsRes = await amoRequest(`/api/v4/contacts?query=${phone}`);
  const contact = contactsRes?._embedded?.contacts?.[0];
  if (!contact) {
    console.log("Contact not found");
    return;
  }

  // 2. Get contact with leads
  const contactFull = await amoRequest(
    `/api/v4/contacts/${contact.id}?with=leads`
  );

  const leads = contactFull?._embedded?.leads || [];
  if (!leads.length) {
    console.log("No leads for contact");
    return;
  }

  // 3. Find lead ONLY in required pipeline
  const targetLead = leads
    .filter((l) => l.pipeline_id === PIPELINE_ID)
    .sort((a, b) => b.id - a.id)[0];

  if (!targetLead) {
    console.log("No lead in target pipeline");
    return;
  }

  // 4. Prepare fields
  const custom_fields_values = [
    {
      field_id: PAYMENT_TYPE_FIELD_ID,
      values: [{ value: row.payment_method }],
    },
    {
      field_id: PAYMENT_DATE_FIELD_ID,
      values: [{ value: Math.floor(Date.now() / 1000) }],
    },
  ];

  let status_id = null;

  if (row.payment_type === "prepayment") {
    custom_fields_values.push({
      field_id: PREPAYMENT_FIELD_ID,
      values: [{ value: Number(row.payment_amount) }],
    });
    status_id = STATUS_PREPAYMENT;
  }

  if (row.payment_type === "full") {
    custom_fields_values.push({
      field_id: FULLPAYMENT_FIELD_ID,
      values: [{ value: Number(row.payment_amount) }],
    });
    status_id = STATUS_FULLPAYMENT;
  }

  // 5. Update lead
  await amoRequest(`/api/v4/leads/${targetLead.id}`, "PATCH", {
    status_id,
    custom_fields_values,
  });

  console.log(`Lead ${targetLead.id} updated`);
}

/* ================= CRON ================= */

cron.schedule("*/5 * * * *", async () => {
  console.log("CRON START");

  // 🔴 ЗАГЛУШКА: ЗАМЕНИШЬ НА ЧТЕНИЕ ИЗ SHEETS
  const testRow = {
    client_phone: "77077599609",
    payment_type: "prepayment", // or "full"
    payment_amount: 10000,
    payment_method: "kaspi",
  };

  await processPayment(testRow);
});

/* ================= SERVICE ================= */

app.get("/health", (req, res) => res.send("ok"));

app.listen(10000, () => {
  console.log("Server running on port 10000");
});
