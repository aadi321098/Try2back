import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const {
  PORT = 5000,
  MONGO_URI,
  PI_API_BASE = "https://api.minepi.com/v2",
  PI_APP_ID,
  PI_SERVER_API_KEY,
  CORS_ORIGINS = "*"
} = process.env;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI in env");
  process.exit(1);
}
if (!PI_SERVER_API_KEY) {
  console.warn("WARNING: Missing PI_SERVER_API_KEY in env (payments won't work).");
}

// ----- Models -----
import User from "./models/User.js";
import Tx from "./models/Transaction.js";

// ----- App -----
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

const corsOrigins = CORS_ORIGINS === "*" ? "*" : CORS_ORIGINS.split(",").map(s => s.trim());
app.use(cors({ origin: corsOrigins, credentials: false }));

// ----- DB connect -----
mongoose.set("strictQuery", true);
mongoose.connect(MONGO_URI).then(() => {
  console.log("MongoDB connected");
}).catch(err => {
  console.error("MongoDB connection error:", err);
  process.exit(1);
});

// Helpers
const now = () => new Date();
const daysBetween = (a, b) => Math.ceil((a.getTime() - b.getTime()) / 86400000);
const computeRemainingDays = (expiry) => {
  if (!expiry) return 0;
  const d = daysBetween(new Date(expiry), now());
  return Math.max(0, d);
};
const serverHeaders = () => ({ Authorization: `Key ${PI_SERVER_API_KEY}` });
const userHeaders = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

// ---------- Routes ----------

// Health
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Verify auth from frontend
// Verify auth from frontend
app.post("/auth/verify", async (req, res) => {
  try {
    const { accessToken, user } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ success: false, message: "Missing accessToken" });
    }

    // Verify user from Pi API
    const me = await axios
      .get(`${PI_API_BASE}/me`, { headers: userHeaders(accessToken) })
      .then(r => r.data);

    const uid = String(me?.uid || user?.uid || "");
    const username = user?.username || me?.username || "Pioneer";

    if (!uid) {
      return res.status(401).json({ success: false, message: "Invalid token/user" });
    }

    // Ensure we only use pi_uid as unique identifier
    let doc = await User.findOne({ pi_uid: uid });

    if (!doc) {
      // New user create
      doc = await User.create({ pi_uid: uid, username });
    } else {
      // Existing user update (username overwrite allowed, no unique constraint)
      doc.username = username;
      await doc.save();
    }

    // Compute premium info
    const remainingDays = computeRemainingDays(doc.premium_expiry);
    const txs = await Tx.find({ pi_uid: uid }).sort({ createdAt: -1 }).limit(100).lean();

    return res.json({
      success: true,
      user: {
        uid,
        username: doc.username,
        premium: !!doc.is_premium && remainingDays > 0,
        premium_expiry: doc.premium_expiry,
        remainingDays,
        transactions: txs.map(t => ({
          paymentId: t.paymentId,
          amount: t.amount,
          status: t.status,
          txid: t.txid,
          processedAt: t.createdAt
        }))
      }
    });
  } catch (err) {
    console.error("/auth/verify error:", err?.response?.data || err.message);
    return res.status(401).json({ success: false, message: "Auth verify failed" });
  }
});
// Server approval
app.post("/payments/approve", async (req, res) => {
  try {
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ success: false, message: "Missing paymentId" });

    const r = await axios.post(`${PI_API_BASE}/payments/${paymentId}/approve`, {}, { headers: serverHeaders() });
    if (r.status >= 200 && r.status < 300) return res.json({ success: true });
    return res.status(400).json({ success: false, message: "Approval failed" });
  } catch (err) {
    console.error("/payments/approve error:", err?.response?.data || err.message);
    return res.status(400).json({ success: false, message: "Approval error" });
  }
});

// Server completion
app.post("/payments/complete", async (req, res) => {
  try {
    const { paymentId, txid } = req.body || {};
    if (!paymentId || !txid) return res.status(400).json({ success: false, message: "Missing paymentId/txid" });

    // Complete
    const comp = await axios.post(
      `${PI_API_BASE}/payments/${paymentId}/complete`,
      { txid },
      { headers: serverHeaders() }
    );

    if (!(comp.status >= 200 && comp.status < 300)) {
      return res.status(400).json({ success: false, message: "Completion failed" });
    }

    // Fetch payment details
    const payment = await axios.get(`${PI_API_BASE}/payments/${paymentId}`, { headers: serverHeaders() })
                               .then(r => r.data);

    const uid = String(payment?.from_uid || payment?.actor_uid || payment?.user_uid || "");
    const amount = Number(payment?.amount || 0);
    const status = payment?.status || "completed";

    if (!uid) return res.status(400).json({ success: false, message: "User not resolved from payment" });

    // Premium logic: 2π = 30 days  (support multiples)
    const blocks = Math.floor(amount / 2);
    const addDays = blocks * 30;

    // Upsert user and extend expiry
    let doc = await User.findOne({ pi_uid: uid });
    if (!doc) {
      doc = await User.create({ pi_uid: uid, username: "Pioneer" });
    }
    const baseDate = (doc.is_premium && doc.premium_expiry && new Date(doc.premium_expiry) > new Date())
      ? new Date(doc.premium_expiry)
      : new Date();

    const newExpiry = new Date(baseDate.getTime() + addDays * 86400000);
    const isPremium = addDays > 0;

    await User.updateOne({ pi_uid: uid }, {
      $set: {
        is_premium: isPremium || (doc.is_premium ?? false),
        premium_expiry: isPremium ? newExpiry : doc.premium_expiry
      }
    });

    // Record transaction
    await Tx.create({
      pi_uid: uid,
      paymentId,
      amount,
      status,
      txid,
      raw: payment
    });

    return res.json({ success: true, new_expiry: newExpiry });
  } catch (err) {
    console.error("/payments/complete error:", err?.response?.data || err.message);
    return res.status(400).json({ success: false, message: "Completion error" });
  }
});

// Get user info
app.get("/user/:uid", async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const doc = await User.findOne({ pi_uid: uid });
    if (!doc) return res.status(404).json({ success: false, message: "User not found" });

    const remainingDays = computeRemainingDays(doc.premium_expiry);
    const txs = await Tx.find({ pi_uid: uid }).sort({ createdAt: -1 }).limit(100).lean();

    return res.json({
      success: true,
      user: {
        uid,
        username: doc.username,
        premium: !!doc.is_premium && remainingDays > 0,
        premium_expiry: doc.premium_expiry,
        remainingDays,
        transactions: txs.map(t => ({
          paymentId: t.paymentId,
          amount: t.amount,
          status: t.status,
          txid: t.txid,
          processedAt: t.createdAt
        }))
      }
    });
  } catch (err) {
    console.error("/user error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
