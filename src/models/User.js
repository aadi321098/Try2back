import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  pi_uid: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: "Pioneer" },
  is_premium: { type: Boolean, default: false },
  premium_expiry: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model("User", UserSchema);
