require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==================== MIDDLEWARE ====================
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS - allow your Cloudflare frontend
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://nyotafund.space',
    'https://www.nyotafund.space'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-TOKEN', 'Authorization']
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// ==================== IN-MEMORY STORAGE ====================
const applications = new Map();
const transactions = new Map();

// Persist data to JSON file so it survives restarts
function saveData() {
  try {
    const data = {
      applications: Array.from(applications.entries()),
      transactions: Array.from(transactions.entries()),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('💾 Save error:', e.message);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.applications) data.applications.forEach(([k, v]) => applications.set(k, v));
      if (data.transactions) data.transactions.forEach(([k, v]) => transactions.set(k, v));
      console.log(`💾 Loaded ${applications.size} apps, ${transactions.size} txs from disk`);
    }
  } catch (e) {
    console.error('💾 Load error:', e.message);
  }
}

// Save every 30 seconds
setInterval(saveData, 30000);
loadData();

// ==================== HELPERS ====================
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

// ==================== ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// CSRF token (static frontend needs a dummy token)
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrf_token: 'nyota-static-token-' + Date.now() });
});

// ----------------------------------------------------
// 1. CHECK ELIGIBILITY
// ----------------------------------------------------
app.post('/api/check-eligibility', async (req, res) => {
  try {
    const { phoneNumber, idNumber } = req.body;

    if (!phoneNumber || !idNumber) {
      return res.status(400).json({
        success: false,
        status: 'error',
        message: 'Phone number and ID number are required.'
      });
    }

    const phone = normalizePhone(phoneNumber);

    // Check if user has active loan
    for (const [, app] of applications) {
      if (app.phoneNumber === phone && ['active', 'paid', 'disbursed'].includes(app.status)) {
        return res.json({
          success: true,
          status: 'active_loan',
          message: 'You have an active loan. Please repay your current loan before applying for a new one.',
          data: {
            loan_amount: app.selectedAmount,
            total_repayment: app.totalRepayment
          }
        });
      }
    }

    // TODO: Add CRB check here if needed
    // const crbCheck = await checkCRB(phone, idNumber);

    return res.json({
      success: true,
      status: 'eligible',
      message: 'Congratulations! You are eligible for a loan.'
    });

  } catch (error) {
    console.error('Eligibility error:', error);
    return res.status(500).json({
      success: false,
      status: 'error',
      message: 'Server error during eligibility check.'
    });
  }
});

// ----------------------------------------------------
// 2. SUBMIT LOAN APPLICATION + INITIATE MEGAPAY STK
// ----------------------------------------------------
app.post('/api/loan-application', async (req, res) => {
  try {
    const data = req.body;
    const {
      fullName,
      phoneNumber,
      idNumber,
      loanType,
      selectedAmount,
      selectedFee,
      interest,
      totalRepayment
    } = data;

    // Validation
    if (!fullName || !phoneNumber || !idNumber || !selectedAmount) {
      return res.status(400).json({
        success: false,
        message: 'Please fill in all required fields.'
      });
    }

    const applicationId = generateAppId();
    const ref = generateRef();
    const phone = normalizePhone(phoneNumber);
    const fee = parseFloat(selectedFee || 0);

    // Save application
    const application = {
      applicationId,
      fullName,
      phoneNumber: phone,
      idNumber,
      loanType: loanType || 'personal',
      selectedAmount: parseFloat(selectedAmount),
      selectedFee: fee,
      interest: parseFloat(interest || 0),
      totalRepayment: parseFloat(totalRepayment || selectedAmount),
      status: 'pending_payment',
      transactionRef: ref,
      createdAt: new Date().toISOString()
    };

    applications.set(applicationId, application);

    // Initiate MegaPay STK Push for processing fee
    const payload = {
      api_key: process.env.MEGAPAY_API_KEY,
      email: process.env.MEGAPAY_EMAIL,
      amount: fee > 0 ? fee : 99, // fallback fee
      msisdn: phone,
      callback_url: process.env.CALLBACK_URL,
      description: `NYOTA Loan Fee - ${applicationId}`,
      reference: ref
    };

    console.log('📤 MegaPay STK Request:', payload);

    const mpResponse = await axios.post(
      'https://megapay.co.ke/backend/v1/initiatestk',
      payload,
      { timeout: 15000 }
    );

    console.log('📥 MegaPay STK Response:', mpResponse.data);

    // Store transaction
    transactions.set(ref, {
      ref,
      applicationId,
      amount: payload.amount,
      phone: phone,
      status: 'pending',
      description: payload.description,
      createdAt: Date.now(),
      megapayResponse: mpResponse.data
    });

    // Immediate save after important state change
    saveData();

    return res.json({
      success: true,
      payment_status: 'pending',
      message: 'M-Pesa prompt sent! Please check your phone and enter your PIN.',
      transaction_id: ref,
      data: {
        application_id: applicationId,
        transaction_id: ref,
        mpesa_receipt_number: null
      }
    });

  } catch (error) {
    console.error('Loan application error:', error.message);
    
    // If MegaPay failed
    if (error.response) {
      console.error('MegaPay error:', error.response.data);
    }

    return res.status(500).json({
      success: false,
      payment_status: 'failed',
      message: 'Failed to initiate payment. Please try again.',
      data: {}
    });
  }
});

// ----------------------------------------------------
// 3. CHECK PAYMENT STATUS BY APPLICATION ID
// (Frontend polling uses this)
// ----------------------------------------------------
app.get('/api/check-payment-status-by-app/:applicationId', (req, res) => {
  const appId = req.params.applicationId;
  const app = applications.get(appId);

  if (!app) {
    return res.status(404).json({
      success: false,
      status: 'not_found',
      message: 'Application not found.'
    });
  }

  const tx = transactions.get(app.transactionRef);

  if (!tx) {
    return res.json({
      success: true,
      status: app.status,
      message: 'Application found. Awaiting payment initiation.',
      data: {
        application_id: appId,
        mpesa_receipt_number: null
      }
    });
  }

  // Map internal status to frontend expected values
  let status = tx.status;
  if (status === 'success') status = 'completed';
  if (status === 'initiated') status = 'pending';

  return res.json({
    success: true,
    status: status,
    message: tx.status === 'success' ? 'Payment confirmed!' : 'Awaiting payment confirmation.',
    data: {
      application_id: appId,
      transaction_id: tx.ref,
      mpesa_receipt_number: tx.receipt || null
    }
  });
});

// ----------------------------------------------------
// 4. DIRECT PAYMENT INITIATE (Alternative endpoint)
// ----------------------------------------------------
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { amount, phone_number, description, reference } = req.body;

    if (!amount || amount < 10) {
      return res.status(400).json({ success: false, message: 'Minimum amount is 10 KES.' });
    }
    if (!phone_number) {
      return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }

    const formattedPhone = normalizePhone(phone_number);
    const ref = reference || generateRef();

    const payload = {
      api_key: process.env.MEGAPAY_API_KEY,
      email: process.env.MEGAPAY_EMAIL,
      amount: parseFloat(amount),
      msisdn: formattedPhone,
      callback_url: process.env.CALLBACK_URL,
      description: description || 'NYOTA Fund Payment',
      reference: ref
    };

    console.log('📤 MegaPay STK Request:', payload);

    const mpResponse = await axios.post(
      'https://megapay.co.ke/backend/v1/initiatestk',
      payload,
      { timeout: 15000 }
    );

    console.log('📥 MegaPay STK Response:', mpResponse.data);

    transactions.set(ref, {
      ref,
      amount: payload.amount,
      phone: formattedPhone,
      status: 'pending',
      description: payload.description,
      createdAt: Date.now(),
      megapayResponse: mpResponse.data
    });

    saveData();

    res.status(200).json({
      success: true,
      message: 'STK Push Sent! Check your phone.',
      reference: ref,
      provider: 'megapay',
      data: mpResponse.data
    });

  } catch (error) {
    console.error('Payment initiation error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Payment Gateway Error. Please try again.'
    });
  }
});

// ----------------------------------------------------
// 5. CHECK PAYMENT STATUS BY REFERENCE
// ----------------------------------------------------
app.get('/api/payment/status/:reference', (req, res) => {
  const ref = req.params.reference;
  const tx = transactions.get(ref);

  if (!tx) {
    return res.status(404).json({
      success: false,
      status: 'not_found',
      message: 'Transaction not found'
    });
  }

  res.json({
    success: true,
    status: tx.status,
    reference: tx.ref,
    amount: tx.amount,
    receipt: tx.receipt || null,
    message: tx.status === 'success' ? 'Payment confirmed' : 'Awaiting confirmation'
  });
});

// ----------------------------------------------------
// 6. MEGAPAY WEBHOOK
// ----------------------------------------------------
app.post('/api/megapay/webhook', async (req, res) => {
  // ACKNOWLEDGE IMMEDIATELY (MegaPay needs fast 200 OK)
  res.status(200).send('OK');

  try {
    const data = req.body;
    console.log('🔔 MegaPay Webhook received:', JSON.stringify(data));

    // Optional: verify webhook secret via query param
    const secret = req.query.secret;
    if (secret && secret !== process.env.WEBHOOK_SECRET) {
      console.warn('⚠️ Invalid webhook secret');
      return;
    }

    // Extract response code (MegaPay sends various formats)
    let responseCode = data.ResponseCode ?? data.ResultCode ?? data.responseCode ?? data.resultCode ?? data.status;

    let isSuccess = (
      responseCode == 0 ||
      responseCode === '0' ||
      responseCode === 'Success' ||
      responseCode === 'success'
    );

    if (!isSuccess) {
      console.log('⛔ Payment not successful. Code:', responseCode);
      const ref = data.reference || data.CheckoutRequestID;
      if (ref && transactions.has(ref)) {
        transactions.get(ref).status = 'failed';
        saveData();
      }
      return;
    }

    // Extract amount
    let amount = parseFloat(
      data.TransactionAmount || data.amount || data.Amount || data.transactionAmount
    );
    if (isNaN(amount) || amount <= 0) {
      console.error('❌ Invalid amount in webhook:', data);
      return;
    }

    // Extract receipt
    let receipt = (
      data.TransactionReceipt ||
      data.MpesaReceiptNumber ||
      data.receipt ||
      data.transactionId ||
      data.reference ||
      'MPESA-' + Date.now()
    );

    // Extract phone
    let rawPhone = data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.phoneNumber;
    if (!rawPhone) {
      console.error('❌ No phone in webhook');
      return;
    }
    rawPhone = rawPhone.toString();

    // Find transaction
    const ref = data.reference || data.CheckoutRequestID;
    let tx = transactions.get(ref);

    // Fallback: search by CheckoutRequestID inside megapayResponse
    if (!tx) {
      for (const [, val] of transactions) {
        if (val.megapayResponse && val.megapayResponse.CheckoutRequestID === data.CheckoutRequestID) {
          tx = val;
          break;
        }
      }
    }

    if (tx) {
      tx.status = 'success';
      tx.receipt = receipt;
      tx.paidAt = Date.now();
      tx.megapayWebhook = data;

      // Update linked application
      const app = applications.get(tx.applicationId);
      if (app) {
        app.status = 'paid';
        app.mpesaReceipt = receipt;
        app.paidAt = new Date().toISOString();
        console.log(`✅ Application ${tx.applicationId} marked as PAID`);
      }

      saveData();
      console.log('✅ Transaction marked success:', ref, 'Receipt:', receipt);
    } else {
      console.log('⚠️ Transaction not found in memory for ref:', ref);
    }

  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
});

// ----------------------------------------------------
// 7. GET APPLICATION DETAILS (for success page)
// ----------------------------------------------------
app.get('/api/application/:applicationId', (req, res) => {
  const app = applications.get(req.params.applicationId);
  if (!app) {
    return res.status(404).json({ success: false, message: 'Application not found' });
  }
  res.json({ success: true, data: app });
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYOTA API running on http://0.0.0.0:${PORT}`);
  console.log(`📡 Webhook URL: ${process.env.CALLBACK_URL}`);
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  saveData();
  process.exit(0);
});