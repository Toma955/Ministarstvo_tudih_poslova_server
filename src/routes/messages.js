import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/auth.js";
import { getUser } from "../db/database.js";
import {
  createVoiceSession,
  getActiveSession,
  getCompletedMessage,
  addEncryptedChunk,
  addKeyOffer,
  completeVoiceSession,
  applyFeedback,
  feedbackState,
  listInboxForDevice,
  getDeliveryPackage,
  getMessageRecord,
} from "../stores/voiceMessageStore.js";
import { notifyVoiceMessageRecipients } from "../services/notifications.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.get("/inbox", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  res.json({ messages: listInboxForDevice(deviceId) });
});

router.post("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  if (!user?.room_code) {
    return res.status(403).json({
      error: "forbidden",
      message: "Niste u sobi. Unesite ključ sobe u aplikaciji.",
    });
  }

  const senderName =
    (typeof req.body?.sender_name === "string" && req.body.sender_name.trim()) ||
    user?.sender_name ||
    user?.display_name ||
    "Nepoznato";

  const sourceType = user?.is_base_station ? "base" : "radio";

  const sessionId = uuidv4();
  createVoiceSession({
    sessionId,
    senderDeviceId: deviceId,
    senderName,
    sourceType,
    roomCode: user?.room_code || null,
  });

  res.status(201).json({ session_id: sessionId });
});

router.post("/:sessionId/key-offers", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const offers = req.body?.offers;

  if (!Array.isArray(offers)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "offers mora biti niz.",
    });
  }

  if (offers.length === 0) {
    return res.json({ ok: true, count: 0, skipped: 0 });
  }

  const session = getMessageRecord(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found", message: "Sesija nije pronađena." });
  }

  if (session.sender_device_id !== deviceId) {
    return res.status(403).json({ error: "forbidden", message: "Sesija pripada drugom korisniku." });
  }

  const sender = getUser(deviceId);
  let applied = 0;
  let skipped = 0;

  for (const offer of offers) {
    const recipientId = offer.recipient_device_id;
    const ciphertext = offer.ciphertext_base64;
    const version = offer.encryption_version ?? 1;

    if (!recipientId || !ciphertext) {
      return res.status(400).json({
        error: "invalid_request",
        message: "Svaki offer treba recipient_device_id i ciphertext_base64.",
      });
    }

    if (recipientId === deviceId) continue;

    const recipient = getUser(recipientId);
    if (!recipient?.room_code || recipient.room_code !== sender?.room_code) {
      skipped += 1;
      continue;
    }

    const result = addKeyOffer(sessionId, recipientId, version, ciphertext);
    if (!result) {
      skipped += 1;
      continue;
    }
    applied += 1;
  }

  if (applied === 0 && skipped > 0) {
    return res.status(409).json({
      error: "conflict",
      message: "Nijedan key offer nije primijenjen.",
      skipped,
    });
  }

  res.json({ ok: true, count: applied, skipped });
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

  const chunk = addEncryptedChunk(sessionId, sequence, encryptionVersion, ciphertextBase64);
  if (!chunk) {
    return res.status(409).json({
      error: "conflict",
      message: "Chunk nije moguće spremiti. Sesija je završena ili ne postoji.",
    });
  }

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

  const completed = completeVoiceSession(sessionId, resolvedName, sequence);
  if (!completed) {
    return res.status(409).json({
      error: "conflict",
      message: "Sesija nije mogla biti završena.",
    });
  }

  const keyOfferCount = completed.key_offers?.size ?? 0;

  notifyVoiceMessageRecipients(completed).catch((error) => {
    console.warn("[push] notify failed", error.message);
  });

  res.json({
    ok: true,
    key_offer_count: keyOfferCount,
    chunk_count: completed.chunk_count ?? 0,
  });
});

router.get("/:sessionId/delivery", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const payload = getDeliveryPackage(sessionId, deviceId);

  if (!payload) {
    return res.status(404).json({
      error: "not_found",
      message: "Poruka nije dostupna za ovaj uređaj.",
    });
  }

  const sender = getUser(payload.sender_device_id);
  res.json({
    ...payload,
    sender_public_key_base64:
      payload.is_plaintext || payload.source_type === "server"
        ? null
        : sender?.public_key_base64 || null,
  });
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
