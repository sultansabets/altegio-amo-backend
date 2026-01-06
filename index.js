import express from 'express';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

// --- Google Sheets setup ---
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// --- health ---
app.get('/health', (req, res) => {
  res.send('ok');
});

// --- test write to sheet ---
app.get('/test-write', async (req, res) => {
  try {
    const values = [[
      `test_${Date.now()}`,
      '77001234567',
      'Test Client',
      'booking_test',
      'Test Service',
      'prepayment',
      10000,
      'kaspi',
      'paid',
      new Date().toISOString(),
      '',
      'new'
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Payments!A1',
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
