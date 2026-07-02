import { Router } from "express";
import { config } from "../config.js";
import { signToken, authMiddleware } from "../middleware/auth.js";
import { joinRoom, getUser, normalizeRoomCode } from "../db/database.js";

const router = Router();

router.post("/join", (req, res) => {
  const {
    room_code: roomCode,
    device_id: deviceId,
    public_key_base64: publicKeyBase64,
    display_name: displayName,
  } = req.body || {};

  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "device_id je obavezan." });
  }

  if (!normalizeRoomCode(roomCode)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Soba mora imati 2–32 znaka (slova, brojke, - ili _).",
    });
  }

  if (!publicKeyBase64) {
    return res.status(400).json({
      error: "invalid_request",
      message: "public_key_base64 je obavezan.",
    });
  }

  const user = joinRoom({
    deviceId,
    roomCode,
    publicKeyBase64,
    displayName,
  });

  if (!user) {
    return res.status(400).json({ error: "invalid_request", message: "Ulaz u sobu nije uspio." });
  }

  const token = signToken({
    role: "user",
    device_id: deviceId,
    room_code: user.room_code,
  });

  res.json({
    access_token: token,
    expires_in: config.jwtExpiresIn,
    room_code: user.room_code,
    device_id: user.device_id,
  });
});

router.get("/session", authMiddleware(), (req, res) => {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    return res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
  }

  const user = getUser(deviceId);
  if (!user || !user.room_code) {
    return res.status(404).json({ error: "not_found", message: "Račun nije pronađen." });
  }

  res.json({
    device_id: user.device_id,
    room_code: user.room_code,
    display_name: user.display_name,
    sender_name: user.sender_name,
    is_base_station: Boolean(user.is_base_station),
  });
});

export default router;
