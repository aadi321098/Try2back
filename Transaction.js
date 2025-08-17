import mongoose from "mongoose";

const TxSchema = new mongoose.Schema({
  pi_uid: { type: String, required: true, index: true },
  paymentId: { type: String, required: true, index: true },
  amount: { type: Number, default: 0 },
  status: { type: String, default: "completed" },
  txid: { type: String },
  raw: { type: Object }
}, { timestamps: true });

export default mongoose.model("Transaction", TxSchema);
