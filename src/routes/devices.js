import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { upsertPushToken, deletePushToken } from "../db/database.js";
import { isApnsConfigured } from "../services/apns.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.put("/push-token", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { apns_token: apnsToken } = req.body || {};
  const normalized = typeof apnsToken === "string" ? apnsToken.trim().toLowerCase() : "";

  if (!normalized || normalized.length < 32) {
    return res.status(400).json({
      error: "invalid_request",
      message: "apns_token je obavezan.",
    });
  }

  upsertPushToken(deviceId, normalized);
  res.json({ ok: true, apns_configured: isApnsConfigured() });
});

router.delete("/push-token", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  deletePushToken(deviceId);
  res.json({ ok: true });
});

export default router;
