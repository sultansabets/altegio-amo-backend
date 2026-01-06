import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
app.use(express.json());

/* ================== CONFIG ================== */

const AMO_BASE_URL = "https://clinicreformatormen.amocrm.ru";
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;

const PIPELINE_ID = 9884630;

const STATUS_PREPAYMENT = 81391378;
const STATUS_FULLPAYMENT = 79666150;

const PREPAYMENT_FIELD_ID = 1026233;
const FULLPAYMENT_FIELD_ID = 1077301;
const PAYMENT_TYPE_FIELD_ID = 1077303;
const PAYMENT_DATE_FIELD_ID = 1077305;

/* enum_id значений списка "Тип оплаты" — ОБЯЗАТЕЛЬНО */
const PAYMENT_TYPE_ENUMS = {
  kaspi: 1,   // ❗ ЗАМЕНИ НА РЕАЛЬНЫЕ enum_id
  cash: 2,
};

/* ================== HELPERS ================== */

function normalizePhone(phone) {
  return phone.replace(/\D/g, "").replace(/^8/, "7");
}

function extractPhones(contact) {
  const field = contact.custom_fields_values?.find(
    (f) => f.field_code === "PHONE"
  );
  if (!field) return [];
  return field.values.map((v) => normalizePhone(v.value));
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

/* ================== CORE LOGIC ================== */

async function processPayment(row) {
  const targetPhone = normalizePhone(row.client_phone);
  console.log("Processing phone:", targetPhone);

  /* 1. GET CONTACTS BY QUERY */
  const contactsRes = await amoRequest(`/api/v4/contacts?query=${targetPhone}&limit=10`);
  const contacts = contactsRes?._embedded?.contacts || [];

  /* 2. STRICT PHONE MATCH */
  const contact = contacts.find((c) =>
    extractPhones(c).includes(targetPhone)
  );

  if (!contact) {
    console.log("❌ No contact with exact phone match");
    return;
  }

  console.log("✅ Matched contact ID:", contact.id);

  /* 3. FIND LEAD STRICTLY IN TARGET PIPELINE */
  const leadsRes = await amoRequest(
    `/api/v4/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[contacts][id]=${contact.id}&order[updated_at]=desc&limit=1`
  );

  const lead = leadsRes?._embedded?.leads?.[0];

  if (!lead) {
    console.log("❌ No lead in target pipeline for this contact");
    return;
  }

  console.log("✅ Target lead ID:", lead.id);

  /* 4. PREPARE FIELDS */
  const custom_fields_values = [
    {
      field_id: PAYMENT_TYPE_FIELD_ID,
      values: [
        {
          enum_id: PAYMENT_TYPE_ENUMS[row.payment_method],
        },
      ],
    },
    {
      field_id: PAYMENT_DATE_FIELD_ID,
      values: [
        {
          value: Math.floor(Date.now() / 1000),
        },
      ],
    },
  ];

  let status_id;

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

  console.log("Updating lead with:", {
    lead_id: lead.id,
    status_id,
    custom_fields_values,
  });

  /* 5. UPDATE LEAD */
  await amoRequest(`/api/v4/leads/${lead.id}`, "PATCH", {
    status_id,
    custom_fields_values,
  });

  console.log(`✅ Lead ${lead.id} updated correctly`);
}

/* ================== CRON ================== */

cron.schedule("*/5 * * * *", async () => {
  console.log("CRON START");

  // ❗ ПОКА ТЕСТ. ЗАМЕНИМ НА GOOGLE SHEETS
  const row = {
    client_phone: "77077599609",
    payment_type: "prepayment", // prepayment | full
    payment_amount: 10000,
    payment_method: "kaspi",
  };

  await processPayment(row);
});

/* ================== SERVICE ================== */

app.get("/health", (req, res) => res.send("ok"));

app.listen(10000, () => {
  console.log("Server running on port 10000");
});
