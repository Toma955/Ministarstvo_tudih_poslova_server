import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/auth.js";
import { getUser } from "../db/database.js";
import {
  createVoiceSession,
  getActiveSession,
  getCompletedMessage,
  addEncryptedChunk,
  completeVoiceSession,
  applyFeedback,
  feedbackState,
} from "../stores/voiceMessageStore.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.post("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  const senderName =
    (typeof req.body?.sender_name === "string" && req.body.sender_name.trim()) ||
    user?.sender_name ||
    user?.display_name ||
    "Nepoznato";

  const sessionId = uuidv4();
  createVoiceSession({
    sessionId,
    senderDeviceId: deviceId,
    senderName,
  });

  res.status(201).json({ session_id: sessionId });
});

router.post("/:sessionId/chunks", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const {
    sequence,
    encryption_version: encryptionVersion = 1,
    ciphertext_base64: ciphertextBase64,
  } = req.body || {};

  if (typeof sequence !== "number" || !ciphertextBase64) {
    return res.status(400).json({
      error: "invalid_request",
      message: "sequence i ciphertext_base64 su obavezni.",
    });
  }

  const session = getActiveSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found", message: "Sesija nije pronađena." });
  }

  if (session.sender_device_id !== deviceId) {
    return res.status(403).json({ error: "forbidden", message: "Sesija pripada drugom korisniku." });
  }

  addEncryptedChunk(sessionId, sequence, encryptionVersion, ciphertextBase64);
  res.json({});
});

router.post("/:sessionId/complete", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const { sequence, sender_name: senderName } = req.body || {};

  if (typeof sequence !== "number") {
    return res.status(400).json({ error: "invalid_request", message: "sequence je obavezan." });
  }

  const session = getActiveSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found", message: "Sesija nije pronađena." });
  }

  if (session.sender_device_id !== deviceId) {
    return res.status(403).json({ error: "forbidden", message: "Sesija pripada drugom korisniku." });
  }

  const user = getUser(deviceId);
  const resolvedName =
    (typeof senderName === "string" && senderName.trim()) ||
    session.sender_name ||
    user?.sender_name ||
    "Nepoznato";

  completeVoiceSession(sessionId, resolvedName, sequence);
  res.json({});
});

router.post("/:sessionId/feedback", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const payload = req.body || {};

  const state = applyFeedback(sessionId, {
    ...payload,
    actor_peer_key: payload.actor_peer_key || deviceId,
  });

  if (!state) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije pronađena." });
  }

  res.json({});
});

router.get("/:sessionId/feedback", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  if (!getCompletedMessage(sessionId) && !getActiveSession(sessionId)) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije pronađena." });
  }

  res.json(feedbackState(sessionId));
});

export default router;
