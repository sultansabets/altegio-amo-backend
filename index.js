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
    requestBody: { values: [[amoLeadId, status]] },
  });
}

// ===============================
// amoCRM helpers (FIXED)
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

  const text = await res.text();

  if (!res.ok) {
    console.error('amoCRM ERROR RESPONSE:', text);
    throw new Error(`amoCRM ${res.status}`);
  }

  if (!text) {
    throw new Error('amoCRM returned empty response');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('amoCRM NON-JSON RESPONSE:', text);
    throw new Error('amoCRM response is not JSON');
  }
}

async function findLeadInPipelineByPhone(phone) {
  const data = await amoRequest(`/api/v4/contacts?query=${phone}`);
  const contact = data?._embedded?.contacts?.[0];
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
app.get('/health', (req, res) => res.send('ok'));

// ===============================
// CRON
// ===============================
cron.schedule('*/3 * * * *', async () => {
  console.log('CRON START');

  try {
    const rows = await getRows();

    for (let i = 0; i < rows.length; i++) {
      const [
        ,
        phone,
        ,
        ,
        ,
        payment_type,
        payment_amount,
        ,
        ,
        payment_datetime,
        ,
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
  } catch (e) {
    console.error('CRON FATAL:', e.message);
  }
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
