//
// Realtime hub — Server-Sent Events.
// Klijent drži otvorenu vezu i prima streaming događaje; ne polla inbox.
//

import { getUser, listDeviceIdsInRoom } from "../db/database.js";
import { voiceLog, shortId, roomSnapshot } from "./voiceLog.js";

/** @typedef {{ res: import('express').Response, deviceId: string, roomCode: string|null }} RealtimeClient */

/** @type {Map<string, Set<RealtimeClient>>} */
const clientsByDevice = new Map();

function writeEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function attachRealtimeClient(res, deviceId, roomCode) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const client = { res, deviceId, roomCode: roomCode || null };
  if (!clientsByDevice.has(deviceId)) {
    clientsByDevice.set(deviceId, new Set());
  }
  clientsByDevice.get(deviceId).add(client);

  const snap = roomSnapshot(roomCode);
  const live = realtimeStats();
  voiceLog("SSE_CONNECT", {
    device: shortId(deviceId),
    ...snap,
    sse_devices: live.devices,
    sse_connections: live.connections,
  });

  writeEvent(res, "connected", {
    device_id: deviceId,
    room_code: roomCode || null,
    users_in_room: snap.users_in_room,
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(": ping\n\n");
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    const set = clientsByDevice.get(deviceId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) clientsByDevice.delete(deviceId);
    const after = realtimeStats();
    voiceLog("SSE_DISCONNECT", {
      device: shortId(deviceId),
      room: roomCode || null,
      sse_devices: after.devices,
      sse_connections: after.connections,
    });
  };

  res.on("close", cleanup);
  res.on("error", cleanup);

  return cleanup;
}

export function updateRealtimeRoom(deviceId, roomCode) {
  const set = clientsByDevice.get(deviceId);
  if (!set) return;
  for (const client of set) {
    client.roomCode = roomCode || null;
  }
  voiceLog("SSE_ROOM_UPDATE", {
    device: shortId(deviceId),
    ...roomSnapshot(roomCode),
  });
}

function emitToDevice(deviceId, event, data) {
  const set = clientsByDevice.get(deviceId);
  if (!set || set.size === 0) {
    return 0;
  }
  let sent = 0;
  for (const client of [...set]) {
    try {
      writeEvent(client.res, event, data);
      sent += 1;
    } catch (error) {
      voiceLog("SSE_EMIT_FAIL", {
        device: shortId(deviceId),
        event,
        error: error?.message || String(error),
      });
      set.delete(client);
    }
  }
  if (set.size === 0) clientsByDevice.delete(deviceId);
  return sent;
}

function recipientIdsForMessage(message, excludeDeviceId) {
  const roomCode = message.room_code || null;
  let ids = [];

  if (roomCode) {
    ids = listDeviceIdsInRoom(roomCode);
  } else if (message.key_offers instanceof Map) {
    ids = [...message.key_offers.keys()];
  }

  return ids.filter((id) => id && id !== excludeDeviceId);
}

export function broadcastVoiceStarted(message) {
  if (!message?.session_id) return { sent: 0 };
  const sender = getUser(message.sender_device_id);
  const senderName =
    message.sender_name ||
    sender?.sender_name ||
    sender?.display_name ||
    "Nepoznato";
  const payload = {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: senderName,
    sender_avatar_jpeg_base64: sender?.avatar_jpeg_base64 || null,
    source_type: message.source_type || "radio",
    room_code: message.room_code || null,
    sample_rate: 16000,
    audio_quality: "live",
  };

  const targets = recipientIdsForMessage(message, message.sender_device_id);
  let sent = 0;
  let offline = 0;
  for (const deviceId of targets) {
    const n = emitToDevice(deviceId, "voice_started", payload);
    if (n > 0) sent += n;
    else offline += 1;
  }

  voiceLog("BROADCAST_VOICE_STARTED", {
    session: shortId(message.session_id),
    sender: shortId(message.sender_device_id),
    name: message.sender_name,
    ...roomSnapshot(message.room_code),
    targets: targets.length,
    sse_delivered: sent,
    no_sse: offline,
  });

  return { sent, targets: targets.length, offline };
}

export function broadcastVoiceChunk(message, chunk) {
  if (!message?.session_id || !chunk) return { sent: 0 };

  const payload = {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    sequence: chunk.sequence,
    encryption_version: chunk.encryption_version ?? chunk.version ?? 1,
    ciphertext_base64: chunk.ciphertext_base64
      || (Buffer.isBuffer(chunk.ciphertext)
        ? chunk.ciphertext.toString("base64")
        : null),
    sample_rate: 16000,
    audio_quality: "live",
  };

  if (!payload.ciphertext_base64) {
    voiceLog("BROADCAST_LQ_CHUNK_SKIP", {
      session: shortId(message.session_id),
      sequence: chunk.sequence,
      reason: "empty_ciphertext",
    });
    return { sent: 0 };
  }

  const targets = recipientIdsForMessage(message, message.sender_device_id);

  let sent = 0;
  let offline = 0;
  for (const deviceId of targets) {
    const n = emitToDevice(deviceId, "voice_chunk", payload);
    if (n > 0) sent += n;
    else offline += 1;
  }

  const cipherBytes = Buffer.from(payload.ciphertext_base64, "base64").length;
  const seq = Number(chunk.sequence) || 0;
  if (seq === 0 || seq % 5 === 0) {
    voiceLog("BROADCAST_LQ_CHUNK", {
      session: shortId(message.session_id),
      sequence: seq,
      quality: "LOW/live 16kHz",
      bytes: cipherBytes,
      targets: targets.length,
      sse_delivered: sent,
      no_sse: offline,
      key_offers: message.key_offers instanceof Map ? message.key_offers.size : 0,
    });
  }

  return { sent, targets: targets.length, offline };
}

export function broadcastVoiceComplete(message) {
  if (!message?.session_id) return { sent: 0 };
  const payload = {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    sequence: message.sequence,
    sample_rate: message.sample_rate ?? 16000,
    has_final_audio: Boolean(message.has_final_audio),
    audio_quality: message.audio_quality || "live",
  };

  const targets = recipientIdsForMessage(message, message.sender_device_id);
  let sent = 0;
  let offline = 0;
  for (const deviceId of targets) {
    const n = emitToDevice(deviceId, "voice_complete", payload);
    if (n > 0) sent += n;
    else offline += 1;
  }

  voiceLog("BROADCAST_VOICE_COMPLETE", {
    session: shortId(message.session_id),
    sender: shortId(message.sender_device_id),
    name: message.sender_name,
    chunks: message.chunk_count ?? message.chunks?.size ?? 0,
    quality: "LOW complete — čeka HQ",
    ...roomSnapshot(message.room_code),
    targets: targets.length,
    sse_delivered: sent,
    no_sse: offline,
  });

  return { sent, targets: targets.length, offline };
}

export function broadcastVoiceFinal(message, chunks) {
  if (!message?.session_id) return { sent: 0 };

  const serialized = (chunks || [])
    .map((chunk) => ({
      sequence: chunk.sequence,
      encryption_version: chunk.encryption_version ?? chunk.version ?? 1,
      ciphertext_base64:
        chunk.ciphertext_base64 ||
        (Buffer.isBuffer(chunk.ciphertext) ? chunk.ciphertext.toString("base64") : null),
    }))
    .filter((c) => c.ciphertext_base64);

  const payload = {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    sample_rate: message.sample_rate ?? 44100,
    has_final_audio: true,
    audio_quality: "final",
    chunks: serialized,
  };

  const targets = recipientIdsForMessage(message, message.sender_device_id);

  let sent = 0;
  let offline = 0;
  for (const deviceId of targets) {
    const n = emitToDevice(deviceId, "voice_final", payload);
    if (n > 0) sent += n;
    else offline += 1;
  }

  const totalBytes = serialized.reduce(
    (sum, c) => sum + Buffer.from(c.ciphertext_base64, "base64").length,
    0
  );

  voiceLog("BROADCAST_HQ_FINAL", {
    session: shortId(message.session_id),
    sender: shortId(message.sender_device_id),
    name: message.sender_name,
    quality: "HIGH/final 44.1kHz",
    hq_chunks: serialized.length,
    hq_bytes: totalBytes,
    sample_rate: payload.sample_rate,
    ...roomSnapshot(message.room_code),
    targets: targets.length,
    sse_delivered: sent,
    no_sse: offline,
  });

  return { sent, targets: targets.length, offline };
}

/**
 * Obavijesti sve uređaje u sobi da je kanal zatvoren / deaktiviran.
 * Zatim zatvara njihove SSE veze.
 */
export function broadcastRoomClosed(roomCode, reason = "deleted") {
  const normalized = typeof roomCode === "string" ? roomCode.trim().toLowerCase() : null;
  if (!normalized) return { sent: 0, targets: 0 };

  const targets = listDeviceIdsInRoom(normalized);
  const payload = {
    room_code: normalized,
    reason,
    message:
      reason === "inactive"
        ? "Kanal je deaktiviran. Ponovno unesite ključ kad bude aktivan."
        : "Kanal je obrisan. Sesija je prekinuta.",
  };

  let sent = 0;
  for (const deviceId of targets) {
    sent += emitToDevice(deviceId, "room_closed", payload);
  }

  voiceLog("BROADCAST_ROOM_CLOSED", {
    room: normalized,
    reason,
    targets: targets.length,
    sse_delivered: sent,
  });

  // Zatvori SSE nakon događaja da klijent ne drži mrtvu sobu.
  for (const deviceId of targets) {
    closeRealtimeClientsForDevice(deviceId);
  }

  return { sent, targets: targets.length };
}

/**
 * Admin (ili sustav) je obrisao račun — odmah kick uređaja.
 */
export function broadcastAccountDeleted(deviceId, reason = "deleted") {
  if (!deviceId) return { sent: 0 };

  const payload = {
    device_id: deviceId,
    reason,
    message:
      reason === "admin"
        ? "Račun je obrisan od strane administracije. Sesija je prekinuta."
        : "Račun je obrisan. Sesija je prekinuta.",
  };

  const sent = emitToDevice(deviceId, "account_deleted", payload);
  voiceLog("BROADCAST_ACCOUNT_DELETED", {
    device: shortId(deviceId),
    reason,
    sse_delivered: sent,
  });
  closeRealtimeClientsForDevice(deviceId);
  return { sent };
}

/** Šalje ažurirani profil (ime/avatar) ostalim uređajima u sobi. */
export function broadcastProfileUpdated(user, excludeDeviceId = null) {
  if (!user?.device_id || !user.room_code) return { sent: 0, targets: 0 };

  const roomCode = user.room_code;
  const targets = listDeviceIdsInRoom(roomCode).filter(
    (id) => id && id !== (excludeDeviceId || user.device_id)
  );

  const payload = {
    device_id: user.device_id,
    room_code: roomCode,
    display_name: user.display_name || "",
    sender_name: user.sender_name || user.display_name || "Nepoznato",
    avatar_jpeg_base64: user.avatar_jpeg_base64 || null,
    initials: (user.sender_name || user.display_name || "NE")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "")
      .join("")
      .slice(0, 2) || "NE",
    is_base_station: Boolean(user.is_base_station),
  };

  let sent = 0;
  for (const deviceId of targets) {
    sent += emitToDevice(deviceId, "profile_updated", payload);
  }

  voiceLog("BROADCAST_PROFILE_UPDATED", {
    device: shortId(user.device_id),
    name: payload.sender_name,
    room: roomCode,
    targets: targets.length,
    sse_delivered: sent,
    has_avatar: Boolean(payload.avatar_jpeg_base64),
  });

  return { sent, targets: targets.length };
}

function closeRealtimeClientsForDevice(deviceId) {
  const set = clientsByDevice.get(deviceId);
  if (!set) return;
  for (const client of [...set]) {
    try {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // ignore
    }
    set.delete(client);
  }
  if (set.size === 0) clientsByDevice.delete(deviceId);
  updateRealtimeRoom(deviceId, null);
}

export function realtimeStats() {
  let connections = 0;
  for (const set of clientsByDevice.values()) {
    connections += set.size;
  }
  return {
    devices: clientsByDevice.size,
    connections,
  };
}

export function roomCodeForDevice(deviceId) {
  return getUser(deviceId)?.room_code || null;
}
