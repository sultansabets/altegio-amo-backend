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
// Health
// ===============================
app.get('/health', (req, res) => {
  res.send('ok');
});

// ===============================
// Altegio Webhook (БОЕВОЙ)
// ===============================
app.post('/webhook/altegio', async (req, res) => {
  try {
    const payload = req.body;

    /**
     * ОЖИДАЕМЫЕ ПОЛЯ (Altegio может прислать больше):
     * payload.event            -> 'payment.created' | 'payment.canceled' | 'booking.created'
     * payload.booking.id
     * payload.booking.service.title
     * payload.client.phone
     * payload.client.name
     * payload.payment.id
     * payload.payment.amount
     * payload.payment.method
     * payload.payment.total_price   (если есть — для определения full)
     */

    console.log('RAW ALTEGIO:', JSON.stringify(payload));

    const bookingId = payload?.booking?.id || payload?.booking_id || '';
    const paymentId = payload?.payment?.id || '';
    const clientPhone = normalizePhone(payload?.client?.phone || '');
    const clientName = payload?.client?.name || '';
    const serviceName = payload?.booking?.service?.title || payload?.service?.title || '';

    if (!bookingId || !clientPhone) {
      return res.status(400).json({ error: 'bookingId or phone missing' });
    }

    // --- Определяем тип события
    let paymentStatus = 'paid';
    if (payload?.event === 'payment.canceled') paymentStatus = 'canceled';

    const amount = Number(payload?.payment?.amount || 0);
    const totalPrice = Number(payload?.payment?.total_price || 0);

    let paymentType = 'prepayment';
    if (totalPrice && amount >= totalPrice) paymentType = 'full';

    // --- Стабильный event_id (защита от дублей)
    const eventId = `altegio_${bookingId}_${paymentId || payload.event || 'event'}`;

    const event = {
      event_id: eventId,
      client_phone: clientPhone,
      client_name: clientName,
      booking_id: bookingId,
      service_name: serviceName,
      payment_type: paymentType,
      payment_amount: amount,
      payment_method: payload?.payment?.method || '',
      payment_status: paymentStatus,
      payment_datetime: new Date().toISOString(),
    };

    // --- Дедупликация
    if (await eventExists(event.event_id)) {
      return res.json({ status: 'duplicate' });
    }

    await writeToSheet(event);
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
