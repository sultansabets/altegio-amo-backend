import express from 'express';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

// ===============================
// Google Sheets setup
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

async function eventExists(eventId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Payments!A:A',
  });

  const rows = res.data.values || [];
  return rows.some(row => row[0] === eventId);
}

async function writeToSheet(data) {
  const values = [[
    data.event_id,
    data.client_phone,
    data.client_name,
    data.booking_id,
    data.service_name,
    data.payment_type,
    data.payment_amount,
    data.payment_method,
    data.payment_status,
    data.payment_datetime,
    '',
    'new'
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Payments!A1',
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

// ===============================
// Health check
// ===============================
app.get('/health', (req, res) => {
  res.send('ok');
});

// ===============================
// Altegio webhook (RAW)
// ===============================
app.post('/webhook/altegio', async (req, res) => {
  try {
    const payload = req.body;

    // ⚠️ ПОКА просто логируем
    console.log('Altegio payload:', JSON.stringify(payload));

    // ⚠️ Пример ручной нормализации (пока тестовая)
    const event = {
      event_id: `altegio_test_${Date.now()}`,
      client_phone: normalizePhone(payload?.client?.phone || ''),
      client_name: payload?.client?.name || '',
      booking_id: payload?.booking_id || '',
      service_name: payload?.service?.title || '',
      payment_type: 'prepayment',
      payment_amount: payload?.payment?.amount || 0,
      payment_method: payload?.payment?.method || '',
      payment_status: 'paid',
      payment_datetime: new Date().toISOString(),
    };

    if (!event.client_phone) {
      return res.status(400).json({ error: 'phone missing' });
    }

    const exists = await eventExists(event.event_id);
    if (exists) {
      return res.json({ status: 'duplicate' });
    }

    await writeToSheet(event);

    res.json({ status: 'ok' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
