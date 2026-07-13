require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = './data.json';

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://nyotafund.space',
    'https://www.nyotafund.space'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-TOKEN', 'Authorization']
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests.' }
});
app.use('/api/', apiLimiter);

// Storage
const applications = new Map();
const transactions = new Map();

function saveData() {
  try {
    const data = {
      applications: Array.from(applications.entries()),
      transactions: Array.from(transactions.entries()),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.applications) data.applications.forEach(([k, v]) => applications.set(k, v));
      if (data.transactions) data.transactions.forEach(([k, v]) => transactions.set(k, v));
      console.log(`Loaded ${applications.size} apps, ${transactions.size} txs`);
    }
  } catch (e) { console.error('Load error:', e.message); }
}

setInterval(saveData, 30000);
loadData();

// Helpers
function normalizePhone(phone) {
  if (!phone) return '';
  phone = phone.toString().replace(/\s+/g, '').replace(/\+/g, '');
  if (phone.startsWith('0')) return '254' + phone.substring(1);
  if (phone.startsWith('254')) return phone;
  return phone;
}

function generateAppId() {
  return 'APP-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateRef() {
  return 'NYOTA-' + Date.now();
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrf_token: 'nyota-static-token-' + Date.now() });
});

// Check eligibility
app.post('/api/check-eligibility', async (req, res) => {
  try {
    const { phoneNumber, idNumber } = req.body;
    if (!phoneNumber || !idNumber) {
      return res.status(400).json({ success: false, status: 'error', message: 'Phone and ID required.' });
    }
    const phone = normalizePhone(phoneNumber);
    for (const [, app] of applications) {
      if (app.phoneNumber === phone && ['active', 'paid', 'disbursed'].includes(app.status)) {
        return res.json({
          success: true,
          status: 'active_loan',
          message: 'You have an active loan. Please repay before applying.',
          data: { loan_amount: app.selectedAmount, total_repayment: app.totalRepayment }
        });
      }
    }
    return res.json({ success: true, status: 'eligible', message: 'You are eligible for a loan.' });
  } catch (error) {
    return res.status(500).json({ success: false, status: 'error', message: 'Server error.' });
  }
});

// Submit loan + initiate MegaPay
app.post('/api/loan-application', async (req, res) => {
  try {
    const data = req.body;
    const { fullName, phoneNumber, idNumber, selectedAmount, selectedFee, interest, totalRepayment } = data;
    if (!fullName || !phoneNumber || !idNumber || !selectedAmount) {
      return res.status(400).json({ success: false, message: 'Please fill all required fields.' });
    }
    const applicationId = generateAppId();
    const ref = generateRef();
    const phone = normalizePhone(phoneNumber);
    const fee = parseFloat(selectedFee || 0);

    const application = {
      applicationId, fullName, phoneNumber: phone, idNumber,
      loanType: data.loanType || 'personal',
      selectedAmount: parseFloat(selectedAmount), selectedFee: fee,
      interest: parseFloat(interest || 0), totalRepayment: parseFloat(totalRepayment || selectedAmount),
      status: 'pending_payment', transactionRef: ref, createdAt: new Date().toISOString()
    };
    applications.set(applicationId, application);

    const payload = {
      api_key: process.env.MEGAPAY_API_KEY,
      email: process.env.MEGAPAY_EMAIL,
      amount: fee > 0 ? fee : 99,
      msisdn: phone,
      callback_url: process.env.CALLBACK_URL,
      description: `NYOTA Loan Fee - ${applicationId}`,
      reference: ref
    };

    console.log('MegaPay STK Request:', payload);
    const mpResponse = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { timeout: 15000 });
    console.log('MegaPay STK Response:', mpResponse.data);

    transactions.set(ref, {
      ref, applicationId, amount: payload.amount, phone: phone,
      status: 'pending', description: payload.description, createdAt: Date.now(),
      megapayResponse: mpResponse.data
    });
    saveData();

    return res.json({
      success: true, payment_status: 'pending',
      message: 'M-Pesa prompt sent! Please check your phone.',
      transaction_id: ref,
      data: { application_id: applicationId, transaction_id: ref, mpesa_receipt_number: null }
    });
  } catch (error) {
    console.error('Loan application error:', error.message);
    return res.status(500).json({ success: false, payment_status: 'failed', message: 'Failed to initiate payment.', data: {} });
  }
});

// Check payment status by app ID
app.get('/api/check-payment-status-by-app/:applicationId', (req, res) => {
  const app = applications.get(req.params.applicationId);
  if (!app) return res.status(404).json({ success: false, status: 'not_found', message: 'Application not found.' });
  const tx = transactions.get(app.transactionRef);
  if (!tx) {
    return res.json({ success: true, status: app.status, message: 'Awaiting payment.', data: { application_id: app.applicationId, mpesa_receipt_number: null } });
  }
  let status = tx.status;
  if (status === 'success') status = 'completed';
  return res.json({
    success: true, status, message: tx.status === 'success' ? 'Payment confirmed!' : 'Awaiting confirmation.',
    data: { application_id: app.applicationId, transaction_id: tx.ref, mpesa_receipt_number: tx.receipt || null }
  });
});

// Get application details
app.get('/api/application/:applicationId', (req, res) => {
  const app = applications.get(req.params.applicationId);
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });
  res.json({ success: true, data: app });
});

// MegaPay Webhook
app.post('/api/megapay/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const data = req.body;
    console.log('MegaPay Webhook:', JSON.stringify(data));
    const secret = req.query.secret;
    if (secret && secret !== process.env.WEBHOOK_SECRET) {
      console.warn('Invalid webhook secret'); return;
    }
    let responseCode = data.ResponseCode ?? data.ResultCode ?? data.responseCode ?? data.resultCode ?? data.status;
    let isSuccess = (responseCode == 0 || responseCode === '0' || responseCode === 'Success' || responseCode === 'success');
    if (!isSuccess) {
      const ref = data.reference || data.CheckoutRequestID;
      if (ref && transactions.has(ref)) transactions.get(ref).status = 'failed';
      return;
    }
    let amount = parseFloat(data.TransactionAmount || data.amount || data.Amount || data.transactionAmount);
    if (isNaN(amount) || amount <= 0) { console.error('Invalid amount'); return; }
    let receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.receipt || data.transactionId || data.reference || ('MPESA-' + Date.now());
    let rawPhone = data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.phoneNumber;
    if (!rawPhone) { console.error('No phone'); return; }
    const ref = data.reference || data.CheckoutRequestID;
    let tx = transactions.get(ref);
    if (!tx) {
      for (const [, val] of transactions) {
        if (val.megapayResponse && val.megapayResponse.CheckoutRequestID === data.CheckoutRequestID) { tx = val; break; }
      }
    }
    if (tx) {
      tx.status = 'success'; tx.receipt = receipt; tx.paidAt = Date.now(); tx.megapayWebhook = data;
      const app = applications.get(tx.applicationId);
      if (app) { app.status = 'paid'; app.mpesaReceipt = receipt; app.paidAt = new Date().toISOString(); }
      saveData();
      console.log('Transaction success:', ref, 'Receipt:', receipt);
    } else {
      console.log('Transaction not found:', ref);
    }
  } catch (err) { console.error('Webhook error:', err); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYOTA API running on http://0.0.0.0:${PORT}`);
  console.log(`Webhook: ${process.env.CALLBACK_URL}`);
});

process.on('SIGINT', () => { saveData(); process.exit(0); });