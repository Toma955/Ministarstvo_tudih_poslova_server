import { Router } from "express";
import { config } from "../config.js";
import { signToken, authMiddleware } from "../middleware/auth.js";
import {
  joinRoom,
  getUser,
  getRoom,
  ensureDefaultRoom,
  listDeviceIdsInRoom,
  leaveRoom,
} from "../db/database.js";
import { isApnsConfigured } from "../services/apns.js";
import { voiceLog, shortId } from "../services/voiceLog.js";
import { updateRealtimeRoom, realtimeStats } from "../services/realtime.js";

const router = Router();

const joinErrors = {
  invalid_format: {
    status: 400,
    message: "Ključ sobe mora imati 2–32 znaka (slova, brojke, - ili _).",
  },
  not_found: {
    status: 404,
    message: "Soba ne postoji. Provjerite ključ s administracije.",
  },
  inactive: {
    status: 403,
    message: "Soba je deaktivirana. Obratite se administraciji.",
  },
};

router.get("/config", (_req, res) => {
  ensureDefaultRoom();
  res.json({
    default_room_code: config.defaultRoomCode,
    default_room_title: config.defaultRoomTitle,
    apns_configured: isApnsConfigured(),
  });
});

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

  if (!publicKeyBase64) {
    return res.status(400).json({
      error: "invalid_request",
      message: "public_key_base64 je obavezan.",
    });
  }

  const result = joinRoom({
    deviceId,
    roomCode,
    publicKeyBase64,
    displayName,
  });

  if (result.error) {
    const mapped = joinErrors[result.error] || {
      status: 400,
      message: "Ulaz u sobu nije uspio.",
    };
    return res.status(mapped.status).json({
      error: result.error,
      message: mapped.message,
    });
  }

  const user = result.user;
  const token = signToken({
    role: "user",
    device_id: deviceId,
    room_code: user.room_code,
  });

  updateRealtimeRoom(deviceId, user.room_code);
  const members = listDeviceIdsInRoom(user.room_code);
  const live = realtimeStats();
  voiceLog("ROOM_JOIN", {
    device: shortId(deviceId),
    name: user.sender_name || user.display_name || displayName || null,
    room: user.room_code,
    users_in_room: members.length,
    device_ids: members.map(shortId),
    sse_devices: live.devices,
    sse_connections: live.connections,
  });

  res.json({
    access_token: token,
    expires_in: config.jwtExpiresIn,
    room_code: user.room_code,
    device_id: user.device_id,
    room_member_count: result.room_member_count ?? members.length,
  });
});

/**
 * Provjera aktivne sesije kanala.
 * Ako soba ne postoji / nije aktivna / korisnik nije u sobi → 404 i čisti membership.
 */
router.get("/session", authMiddleware(), (req, res) => {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    return res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
  }

  const user = getUser(deviceId);
  if (!user || !user.room_code) {
    return res.status(404).json({
      error: "not_found",
      reason: "no_membership",
      message: "Niste u kanalu.",
    });
  }

  const room = getRoom(user.room_code);
  if (!room) {
    leaveRoom(deviceId);
    updateRealtimeRoom(deviceId, null);
    voiceLog("SESSION_INVALID", {
      device: shortId(deviceId),
      reason: "room_missing",
      room: user.room_code,
    });
    return res.status(404).json({
      error: "not_found",
      reason: "room_missing",
      message: "Kanal više ne postoji. Sesija je prekinuta.",
    });
  }

  if (!room.is_active) {
    leaveRoom(deviceId);
    updateRealtimeRoom(deviceId, null);
    voiceLog("SESSION_INVALID", {
      device: shortId(deviceId),
      reason: "room_inactive",
      room: user.room_code,
    });
    return res.status(404).json({
      error: "not_found",
      reason: "room_inactive",
      message: "Kanal je deaktiviran. Sesija je prekinuta.",
    });
  }

  res.json({
    device_id: user.device_id,
    room_code: user.room_code,
    display_name: user.display_name,
    sender_name: user.sender_name,
    is_base_station: Boolean(user.is_base_station),
    room_active: true,
  });
});

export default router;
