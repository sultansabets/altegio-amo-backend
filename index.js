import express from 'express';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

// ===============================
// Google Sheets
// ===============================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ===============================
// Utils
// ===============================
function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.toString().replace(/\D/g, '');
  if (p.startsWith('8')) p = '7' + p.slice(1);
  if (p.startsWith('7') && p.length === 11) return p;
  return p;
}

async function getRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Payments!A2:L',
  });
  return res.data.values || [];
}

async function updateRow(rowIndex, amoLeadId, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Payments!K${rowIndex}:L${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[amoLeadId, status]],
    },
  });
}

// ===============================
// amoCRM helpers
// ===============================
async function amoRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${process.env.AMO_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.AMO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  return res.json();
}

async function findLeadInPipelineByPhone(phone) {
  const res = await amoRequest(`/api/v4/contacts?query=${phone}`);
  const contact = res?._embedded?.contacts?.[0];
  if (!contact) return null;

  const pipelineId = Number(process.env.AMO_PIPELINE_ID);
  const leads = contact._embedded?.leads || [];

  return leads.find(l => l.pipeline_id === pipelineId) || null;
}

async function updateLead(leadId, statusId, fields) {
  await amoRequest(`/api/v4/leads/${leadId}`, 'PATCH', {
    status_id: statusId,
    custom_fields_values: fields,
  });
}

// ===============================
// Health
// ===============================
app.get('/health', (req, res) => {
  res.send('ok');
});

// ===============================
// Altegio webhook (приём)
// ===============================
app.post('/webhook/altegio', (req, res) => {
  console.log('ALTEGIO EVENT:', JSON.stringify(req.body));
  res.json({ status: 'accepted' });
});

// ===============================
// CRON: Sheets → amoCRM
// ===============================
cron.schedule('*/3 * * * *', async () => {
  console.log('CRON START');

  try {
    const rows = await getRows();

    for (let i = 0; i < rows.length; i++) {
      const [
        event_id,
        phone,
        ,
        ,
        ,
        payment_type,
        payment_amount,
        ,
        payment_status,
        payment_datetime,
        amo_lead_id,
        sync_status,
      ] = rows[i];

      if (sync_status !== 'new') continue;

      const lead = await findLeadInPipelineByPhone(phone);
      if (!lead) {
        await updateRow(i + 2, '', 'error');
        continue;
      }

      const fields = [];

      if (payment_type === 'prepayment') {
        fields.push({
          field_id: Number(process.env.AMO_FIELD_PREPAY_SUM),
          values: [{ value: payment_amount }],
        });
      }

      if (payment_type === 'full') {
        fields.push({
          field_id: Number(process.env.AMO_FIELD_FULLPAY_SUM),
          values: [{ value: payment_amount }],
        });
      }

      fields.push({
        field_id: Number(process.env.AMO_FIELD_PAY_TYPE),
        values: [{ value: payment_type }],
      });

      fields.push({
        field_id: Number(process.env.AMO_FIELD_PAY_DATE),
        values: [{ value: payment_datetime }],
      });

      const statusId =
        payment_type === 'full'
          ? Number(process.env.AMO_STATUS_FULLPAY)
          : Number(process.env.AMO_STATUS_PREPAY);

      await updateLead(lead.id, statusId, fields);
      await updateRow(i + 2, lead.id, 'sent');
    }
  } catch (err) {
    console.error('CRON ERROR:', err.message);
  }
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
