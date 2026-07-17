import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { signToken, authMiddleware } from "../middleware/auth.js";
import {
  getAdminByUsername,
  listUsers,
  getUser,
  deleteUser,
  setAppSetting,
  getAppSetting,
  listRooms,
  createRoom,
  setRoomActive,
  deleteRoom,
  forceDeleteRoom,
  getRoom,
  normalizeRoomCode,
  listDeviceIdsInRoom,
} from "../db/database.js";
import {
  listCompletedMessages,
  listActiveSessionsForAdmin,
  deleteCompletedMessage,
  memoryStats,
  getCompletedMessage,
  createServerBroadcast,
  getAdminMessageAudio,
  purgeUserFromMemory,
  purgeRoomVoiceMemory,
  uuidv4,
} from "../stores/voiceMessageStore.js";
import { notifyVoiceMessageRecipients } from "../services/notifications.js";
import { broadcastRoomClosed, broadcastAccountDeleted } from "../services/realtime.js";

const router = Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "invalid_request", message: "username i password su obavezni." });
  }

  const admin = getAdminByUsername(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: "unauthorized", message: "Pogrešni podaci za prijavu." });
  }

  const token = signToken({
    role: "admin",
    admin_id: admin.id,
    username: admin.username,
  });

  res.json({
    access_token: token,
    expires_in: config.jwtExpiresIn,
    username: admin.username,
  });
});

router.get("/me", authMiddleware("admin"), (req, res) => {
  res.json({
    username: req.auth.username,
    role: "admin",
  });
});

router.get("/stats", authMiddleware("admin"), (_req, res) => {
  const users = listUsers();
  res.json({
    users_count: users.length,
    memory: memoryStats(),
  });
});

router.get("/users", authMiddleware("admin"), (_req, res) => {
  res.json({ users: listUsers() });
});

router.get("/users/:deviceId", authMiddleware("admin"), (req, res) => {
  const user = getUser(req.params.deviceId);
  if (!user) {
    return res.status(404).json({ error: "not_found", message: "Korisnik nije pronađen." });
  }

  res.json({ user });
});

router.delete("/users/:deviceId", authMiddleware("admin"), (req, res) => {
  const deviceId = req.params.deviceId;
  broadcastAccountDeleted(deviceId, "admin");
  purgeUserFromMemory(deviceId);
  const deleted = deleteUser(deviceId);
  if (!deleted) {
    return res.status(404).json({ error: "not_found", message: "Korisnik nije pronađen." });
  }
  res.json({ ok: true, kicked: true });
});

router.get("/rooms", authMiddleware("admin"), (_req, res) => {
  res.json({ rooms: listRooms() });
});

router.post("/rooms", authMiddleware("admin"), (req, res) => {
  const { room_code: roomCode, title } = req.body || {};

  if (!roomCode || typeof roomCode !== "string") {
    return res.status(400).json({
      error: "invalid_request",
      message: "room_code je obavezan.",
    });
  }

  const result = createRoom({ roomCode, title });

  if (result.error === "invalid_format") {
    return res.status(400).json({
      error: result.error,
      message: "Ključ sobe mora imati 2–32 znaka (slova, brojke, - ili _).",
    });
  }

  if (result.error === "already_exists") {
    return res.status(409).json({
      error: result.error,
      message: "Soba s tim ključem već postoji.",
    });
  }

  res.status(201).json({ room: result.room });
});

router.patch("/rooms/:roomCode", authMiddleware("admin"), (req, res) => {
  const { is_active: isActive } = req.body || {};

  if (typeof isActive !== "boolean") {
    return res.status(400).json({
      error: "invalid_request",
      message: "is_active mora biti boolean.",
    });
  }

  const code = normalizeRoomCode(req.params.roomCode) || req.params.roomCode;
  const beforeMembers = isActive ? [] : listDeviceIdsInRoom(code);

  if (!isActive && beforeMembers.length > 0) {
    // Prvo SSE kick, zatim deaktivacija (session check također izbacuje).
    broadcastRoomClosed(code, "inactive");
  }

  const room = setRoomActive(req.params.roomCode, isActive);
  if (!room) {
    return res.status(404).json({ error: "not_found", message: "Soba nije pronađena." });
  }

  if (!isActive) {
    // Članovi ostaju u DB dok ne prođu session check / room_closed — leave se radi u session.
    // Ovdje samo očisti voice RAM za sobu.
    purgeRoomVoiceMemory(room.room_code);
  }

  res.json({
    room_code: room.room_code,
    title: room.title,
    is_active: Boolean(room.is_active),
    created_at: room.created_at,
    kicked: !isActive ? beforeMembers.length : 0,
  });
});

router.delete("/rooms/:roomCode", authMiddleware("admin"), (req, res) => {
  const code = normalizeRoomCode(req.params.roomCode) || req.params.roomCode;
  const force =
    req.query.force === "1" ||
    req.query.force === "true" ||
    req.body?.force === true;

  // Soft path: empty room only (stari admin UI).
  if (!force) {
    const result = deleteRoom(req.params.roomCode);

    if (result.error === "not_found") {
      return res.status(404).json({ error: "not_found", message: "Soba nije pronađena." });
    }

    if (result.error === "not_empty") {
      // Automatski force — admin očekuje da brisanje prekine sesije.
      broadcastRoomClosed(code, "deleted");
      purgeRoomVoiceMemory(code);
      const forced = forceDeleteRoom(req.params.roomCode);
      if (forced.error === "not_found") {
        return res.status(404).json({ error: "not_found", message: "Soba nije pronađena." });
      }
      return res.json({
        ok: true,
        forced: true,
        evicted: forced.evicted_device_ids?.length ?? result.member_count,
      });
    }

    if (result.error === "invalid_format") {
      return res.status(400).json({
        error: result.error,
        message: "Nevaljan ključ sobe.",
      });
    }

    return res.json({ ok: true, forced: false, evicted: 0 });
  }

  broadcastRoomClosed(code, "deleted");
  purgeRoomVoiceMemory(code);
  const forced = forceDeleteRoom(req.params.roomCode);
  if (forced.error === "not_found") {
    return res.status(404).json({ error: "not_found", message: "Soba nije pronađena." });
  }
  if (forced.error === "invalid_format") {
    return res.status(400).json({ error: forced.error, message: "Nevaljan ključ sobe." });
  }

  res.json({
    ok: true,
    forced: true,
    evicted: forced.evicted_device_ids?.length ?? 0,
  });
});

router.get("/messages", authMiddleware("admin"), (_req, res) => {
  const completed = listCompletedMessages();
  const active = listActiveSessionsForAdmin();
  res.json({
    messages: [...active, ...completed],
    active_count: active.length,
    completed_count: completed.length,
  });
});

router.post("/messages/broadcast", authMiddleware("admin"), (req, res) => {
  const { room_code: roomCode, sender_name: senderName, wav_base64: wavBase64 } = req.body || {};

  const normalizedRoom =
    normalizeRoomCode(roomCode) || normalizeRoomCode(config.defaultRoomCode);
  if (!normalizedRoom) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Kanal nije konfiguriran.",
    });
  }

  if (!getRoom(normalizedRoom)) {
    return res.status(404).json({
      error: "not_found",
      message: "Soba ne postoji.",
    });
  }

  if (!wavBase64 || typeof wavBase64 !== "string") {
    return res.status(400).json({
      error: "invalid_request",
      message: "wav_base64 je obavezan.",
    });
  }

  let wavBuffer;
  try {
    wavBuffer = Buffer.from(wavBase64, "base64");
  } catch {
    return res.status(400).json({
      error: "invalid_request",
      message: "wav_base64 nije valjan.",
    });
  }

  if (wavBuffer.length < 48) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Snimka je prazna.",
    });
  }

  const sessionId = uuidv4();
  const message = createServerBroadcast({
    sessionId,
    roomCode: normalizedRoom,
    senderName:
      (typeof senderName === "string" && senderName.trim()) || "Centrala",
    wavBuffer,
  });

  notifyVoiceMessageRecipients(message).catch((error) => {
    console.warn("[push] broadcast notify failed", error.message);
  });

  res.status(201).json({
    session_id: message.session_id,
    source_type: message.source_type,
    room_code: message.room_code,
    sender_name: message.sender_name,
  });
});

router.get("/messages/:sessionId/audio", authMiddleware("admin"), (req, res) => {
  const audio = getAdminMessageAudio(req.params.sessionId);
  if (!audio) {
    return res.status(404).json({ error: "not_found", message: "Audio nije dostupan." });
  }

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  res.send(audio);
});

router.get("/messages/:sessionId", authMiddleware("admin"), (req, res) => {
  const message = getCompletedMessage(req.params.sessionId);
  if (!message) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije u memoriji." });
  }

  res.json({
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    room_code: message.room_code || null,
    chunk_count: message.chunk_count,
    sequence: message.sequence,
    created_at: message.created_at,
    completed_at: message.completed_at,
    base_feedback: message.base_feedback,
    person_feedback: message.person_feedback,
    has_audio: Boolean(message.wav_data) || message.chunk_count > 0,
  });
});

router.delete("/messages/:sessionId", authMiddleware("admin"), (req, res) => {
  const deleted = deleteCompletedMessage(req.params.sessionId);
  if (!deleted) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije u memoriji." });
  }
  res.json({ ok: true });
});

router.get("/settings/operating-status", authMiddleware("admin"), (_req, res) => {
  res.json(getAppSetting("operating_status", {}));
});

router.put("/settings/operating-status", authMiddleware("admin"), (req, res) => {
  const body = req.body || {};
  const current = getAppSetting("operating_status", {});

  const next = {
    is_operational:
      typeof body.is_operational === "boolean"
        ? body.is_operational
        : Boolean(current.is_operational ?? true),
    message: typeof body.message === "string" ? body.message : current.message || "",
    resumes_at: body.resumes_at ?? current.resumes_at ?? null,
    working_hours_label:
      typeof body.working_hours_label === "string"
        ? body.working_hours_label
        : current.working_hours_label || null,
  };

  setAppSetting("operating_status", next);
  res.json(next);
});

router.get("/settings/system-message", authMiddleware("admin"), (_req, res) => {
  res.json(getAppSetting("system_message", {}));
});

router.put("/settings/system-message", authMiddleware("admin"), (req, res) => {
  const body = req.body || {};
  const current = getAppSetting("system_message", {});
  const allowedSeverity = new Set(["info", "warning", "error"]);

  const next = {
    is_active:
      typeof body.is_active === "boolean"
        ? body.is_active
        : Boolean(current.is_active ?? false),
    title: body.title !== undefined ? body.title : current.title ?? null,
    message: typeof body.message === "string" ? body.message : current.message || "",
    severity: allowedSeverity.has(body.severity)
      ? body.severity
      : current.severity || "info",
    blocks_app:
      typeof body.blocks_app === "boolean"
        ? body.blocks_app
        : Boolean(current.blocks_app ?? false),
  };

  setAppSetting("system_message", next);
  res.json(next);
});

export default router;
