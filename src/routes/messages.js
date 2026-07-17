import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/auth.js";
import { getUser, listDeviceIdsInRoom } from "../db/database.js";
import {
  createVoiceSession,
  getActiveSession,
  getCompletedMessage,
  addEncryptedChunk,
  addKeyOffer,
  completeVoiceSession,
  replaceFinalAudio,
  applyFeedback,
  feedbackState,
  listInboxForDevice,
  getDeliveryPackage,
  getMessageRecord,
} from "../stores/voiceMessageStore.js";
import { notifyVoiceMessageRecipients, notifyVoiceStarted } from "../services/notifications.js";
import {
  broadcastVoiceStarted,
  broadcastVoiceChunk,
  broadcastVoiceComplete,
  broadcastVoiceFinal,
  realtimeStats,
} from "../services/realtime.js";
import { voiceLog, shortId, logDeviceRoom } from "../services/voiceLog.js";

const router = Router();

function parseSequence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

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

  const messages = listInboxForDevice(deviceId);
  logDeviceRoom("INBOX_FETCH", deviceId, {
    messages: messages.length,
    active: messages.filter((m) => !m.is_complete).length,
    complete: messages.filter((m) => m.is_complete).length,
  });

  res.json({ messages });
});

router.post("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  if (!user?.room_code) {
    voiceLog("SESSION_CREATE_BLOCKED", {
      device: shortId(deviceId),
      reason: "not_in_room",
    });
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
  const roomUsers = listDeviceIdsInRoom(user.room_code);
  const live = realtimeStats();

  const sessionId = uuidv4();
  const session = createVoiceSession({
    sessionId,
    senderDeviceId: deviceId,
    senderName,
    sourceType,
    roomCode: user?.room_code || null,
  });

  voiceLog("SESSION_CREATE", {
    session: shortId(sessionId),
    sender: shortId(deviceId),
    name: senderName,
    room: user.room_code,
    users_in_room: roomUsers.length,
    recipients: Math.max(roomUsers.length - 1, 0),
    sse_devices: live.devices,
    sse_connections: live.connections,
    quality_plan: "LOW live 16kHz → HIGH final 44.1kHz",
  });

  // voice_started ide tek nakon key-offers — inače receiver dekriptira prije ključa.
  voiceLog("LOW_STREAM_WAITING_KEYS", {
    session: shortId(sessionId),
    room: user.room_code,
    users_in_room: roomUsers.length,
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
  const sessionRoom = session.room_code || sender?.room_code || null;
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
    if (!sessionRoom || !recipient?.room_code || recipient.room_code !== sessionRoom) {
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

  voiceLog("KEY_OFFERS", {
    session: shortId(sessionId),
    sender: shortId(deviceId),
    room: sessionRoom,
    users_in_room: sessionRoom ? listDeviceIdsInRoom(sessionRoom).length : 0,
    applied,
    skipped,
    offers_sent: offers.length,
  });

  // Prvi uspješan key offer → obavijesti sobu da stream kreće (ključevi su spremni).
  const fresh = getMessageRecord(sessionId);
  if (applied > 0 && fresh && !fresh.started_notified) {
    fresh.started_notified = true;
    const started = broadcastVoiceStarted(fresh);
    notifyVoiceStarted(fresh).catch((error) => {
      console.warn("[push] voice_started notify failed", error.message);
    });
    voiceLog("LOW_STREAM_BEGIN", {
      session: shortId(sessionId),
      room: sessionRoom,
      users_in_room: sessionRoom ? listDeviceIdsInRoom(sessionRoom).length : 0,
      sse_delivered: started.sent,
      no_sse: started.offline,
      after: "key_offers",
    });
  }

  res.json({
    ok: true,
    count: applied,
    skipped,
    session_room: sessionRoom,
    warning:
      applied === 0 && skipped > 0
        ? "Nijedan primatelj nije primio key offer (provjeri sobu i javne ključeve)."
        : null,
  });
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

  const parsedSequence = parseSequence(sequence);
  if (parsedSequence === null || !ciphertextBase64) {
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

  const chunk = addEncryptedChunk(
    sessionId,
    parsedSequence,
    encryptionVersion,
    ciphertextBase64
  );
  if (!chunk) {
    return res.status(409).json({
      error: "conflict",
      message: "Chunk nije moguće spremiti. Sesija je završena ili ne postoji.",
    });
  }

  if (parsedSequence === 0 || chunk.chunks.size === 1) {
    voiceLog("LOW_CHUNK_FIRST", {
      session: shortId(sessionId),
      sender: shortId(deviceId),
      name: session.sender_name,
      room: session.room_code,
      users_in_room: session.room_code ? listDeviceIdsInRoom(session.room_code).length : 0,
      quality: "LOW/live 16kHz",
      cipher_bytes: Buffer.from(ciphertextBase64, "base64").length,
      key_offers: session.key_offers?.size ?? 0,
    });
  }

  // Ako key-offers nisu stigli, pokreni stream signal na prvom chunku.
  if (!session.started_notified) {
    session.started_notified = true;
    const started = broadcastVoiceStarted(session);
    notifyVoiceStarted(session).catch((error) => {
      console.warn("[push] voice_started notify failed", error.message);
    });
    voiceLog("LOW_STREAM_BEGIN", {
      session: shortId(sessionId),
      room: session.room_code,
      users_in_room: session.room_code ? listDeviceIdsInRoom(session.room_code).length : 0,
      sse_delivered: started.sent,
      no_sse: started.offline,
      after: "first_chunk_fallback",
    });
  }

  // Server šalje chunk uređajima — klijent ne pita.
  broadcastVoiceChunk(session, {
    sequence: parsedSequence,
    encryption_version: encryptionVersion,
    ciphertext_base64: ciphertextBase64,
  });

  res.json({
    ok: true,
    chunk_count: chunk.chunks.size,
    sequence: parsedSequence,
  });
});

router.post("/:sessionId/complete", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const { sequence, sender_name: senderName } = req.body || {};

  const parsedSequence = parseSequence(sequence);
  if (parsedSequence === null) {
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

  const completed = completeVoiceSession(sessionId, resolvedName, parsedSequence);
  if (!completed) {
    return res.status(409).json({
      error: "conflict",
      message: "Sesija nije mogla biti završena.",
    });
  }

  const keyOfferCount = completed.key_offers?.size ?? 0;
  const chunkCount = completed.chunk_count ?? 0;

  voiceLog("LOW_STREAM_COMPLETE", {
    session: shortId(sessionId),
    sender: shortId(deviceId),
    name: resolvedName,
    room: completed.room_code,
    users_in_room: completed.room_code ? listDeviceIdsInRoom(completed.room_code).length : 0,
    low_chunks: chunkCount,
    key_offers: keyOfferCount,
    quality: "LOW complete — waiting HQ",
  });

  broadcastVoiceComplete(completed);

  notifyVoiceMessageRecipients(completed).catch((error) => {
    console.warn("[push] notify failed", error.message);
  });

  res.json({
    ok: true,
    key_offer_count: keyOfferCount,
    chunk_count: chunkCount,
    warning:
      chunkCount === 0
        ? "Poruka završena bez audio chunkova."
        : keyOfferCount === 0
          ? "Poruka nema key offers — primatelji je neće moći dekriptirati."
          : null,
  });
});

router.post("/:sessionId/final", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const {
    chunks,
    sample_rate: sampleRate,
    sequence,
  } = req.body || {};

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return res.status(400).json({
      error: "invalid_request",
      message: "chunks mora biti neprazan niz.",
    });
  }

  voiceLog("HQ_UPLOAD_BEGIN", {
    session: shortId(sessionId),
    sender: shortId(deviceId),
    quality: "HIGH/final 44.1kHz",
    hq_chunks: chunks.length,
    sample_rate: sampleRate ?? 44100,
  });

  const message = getCompletedMessage(sessionId);
  if (!message) {
    const active = getActiveSession(sessionId);
    if (active) {
      voiceLog("HQ_UPLOAD_TOO_EARLY", {
        session: shortId(sessionId),
        reason: "session_still_active",
      });
      return res.status(409).json({
        error: "conflict",
        message: "Prvo završi sesiju (complete), zatim pošalji finalnu snimku.",
      });
    }
    voiceLog("HQ_UPLOAD_MISSING", { session: shortId(sessionId) });
    return res.status(404).json({ error: "not_found", message: "Sesija nije pronađena." });
  }

  if (message.sender_device_id !== deviceId) {
    return res.status(403).json({ error: "forbidden", message: "Sesija pripada drugom korisniku." });
  }

  const parsedSampleRate =
    typeof sampleRate === "number" && Number.isFinite(sampleRate) ? sampleRate : null;

  const updated = replaceFinalAudio(sessionId, chunks, parsedSampleRate);
  if (!updated) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Finalna snimka nije prihvaćena.",
    });
  }

  const parsedSequence = parseSequence(sequence);
  if (parsedSequence !== null) {
    updated.sequence = Math.max(updated.sequence ?? 0, parsedSequence);
  }

  const finalChunks = [...updated.chunks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seq, chunk]) => ({
      sequence: seq,
      encryption_version: chunk.version ?? 1,
      ciphertext: chunk.ciphertext,
    }));

  broadcastVoiceFinal(updated, finalChunks);

  voiceLog("HQ_UPLOAD_DONE", {
    session: shortId(sessionId),
    sender: shortId(deviceId),
    name: updated.sender_name,
    room: updated.room_code,
    users_in_room: updated.room_code ? listDeviceIdsInRoom(updated.room_code).length : 0,
    quality: "HIGH/final replaced LOW",
    hq_chunks: updated.chunk_count,
    sample_rate: updated.sample_rate,
  });

  res.json({
    ok: true,
    chunk_count: updated.chunk_count,
    has_final_audio: true,
    sample_rate: updated.sample_rate,
    audio_quality: "final",
  });
});

router.get("/:sessionId/delivery", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { sessionId } = req.params;
  const roomFromToken =
    typeof req.auth?.room_code === "string" ? req.auth.room_code.trim().toLowerCase() : null;
  const payload = getDeliveryPackage(sessionId, deviceId, { roomFromToken });

  if (!payload || payload.error) {
    voiceLog("DELIVERY_DENIED", {
      session: shortId(sessionId),
      device: shortId(deviceId),
      reason: payload?.error || "unknown",
      detail: payload?.detail || null,
      token_room: roomFromToken,
    });
    return res.status(404).json({
      error: "not_found",
      message: "Poruka nije dostupna za ovaj uređaj.",
      reason: payload?.error || "unknown",
    });
  }

  voiceLog("DELIVERY_OK", {
    session: shortId(sessionId),
    device: shortId(deviceId),
    chunks: payload.chunks?.length ?? 0,
    complete: payload.is_complete,
    key_pending: Boolean(payload.key_pending),
    quality: payload.audio_quality || (payload.has_final_audio ? "final" : "live"),
    has_final: Boolean(payload.has_final_audio),
    sample_rate: payload.sample_rate,
  });

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
