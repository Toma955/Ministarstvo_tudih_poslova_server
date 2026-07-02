import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { signToken } from "../middleware/auth.js";
import { getUser, upsertUser } from "../db/database.js";

const router = Router();

router.post("/register", (req, res) => {
  const { device_id: deviceId, public_key_base64: publicKeyBase64, display_name: displayName } =
    req.body || {};

  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "device_id je obavezan." });
  }

  const name = typeof displayName === "string" ? displayName.trim() : "";
  const existing = getUser(deviceId);

  upsertUser({
    device_id: deviceId,
    display_name: name || existing?.display_name || "",
    sender_name: name || existing?.sender_name || "Nepoznato",
    avatar_jpeg_base64: existing?.avatar_jpeg_base64 || null,
    public_key_base64: publicKeyBase64 || existing?.public_key_base64 || null,
    is_base_station: existing?.is_base_station || 0,
  });

  const token = signToken({
    role: "user",
    device_id: deviceId,
  });

  res.json({
    access_token: token,
    expires_in: config.jwtExpiresIn,
  });
});

export default router;
