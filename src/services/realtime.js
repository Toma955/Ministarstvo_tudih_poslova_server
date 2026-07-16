//
// Realtime hub — Server-Sent Events.
// Klijent drži otvorenu vezu i prima streaming događaje; ne polla inbox.
//

import { getUser, listDeviceIdsInRoom } from "../db/database.js";

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

  writeEvent(res, "connected", {
    device_id: deviceId,
    room_code: roomCode || null,
  });

  // Keepalive — proxy/load balancer ne zatvara idle vezu.
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
}

function emitToDevice(deviceId, event, data) {
  const set = clientsByDevice.get(deviceId);
  if (!set) return 0;
  let sent = 0;
  for (const client of [...set]) {
    try {
      writeEvent(client.res, event, data);
      sent += 1;
    } catch {
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

/**
 * Server → uređaji u sobi: streaming počinje.
 */
export function broadcastVoiceStarted(message) {
  if (!message?.session_id) return { sent: 0 };
  const payload = {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    room_code: message.room_code || null,
    sample_rate: 16000,
    audio_quality: "live",
  };

  let sent = 0;
  for (const deviceId of recipientIdsForMessage(message, message.sender_device_id)) {
    sent += emitToDevice(deviceId, "voice_started", payload);
  }
  return { sent };
}

/**
 * Server → uređaji: live PCM chunk (već enkriptiran ciphertext).
 */
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

  if (!payload.ciphertext_base64) return { sent: 0 };

  let sent = 0;
  // Samo oni koji imaju key offer (mogu dekriptirati), inače cijela soba.
  const targets =
    message.key_offers instanceof Map && message.key_offers.size > 0
      ? [...message.key_offers.keys()].filter((id) => id !== message.sender_device_id)
      : recipientIdsForMessage(message, message.sender_device_id);

  for (const deviceId of targets) {
    sent += emitToDevice(deviceId, "voice_chunk", payload);
  }
  return { sent };
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

  let sent = 0;
  for (const deviceId of recipientIdsForMessage(message, message.sender_device_id)) {
    sent += emitToDevice(deviceId, "voice_complete", payload);
  }
  return { sent };
}

export function broadcastVoiceFinal(message, chunks) {
  if (!message?.session_id) return { sent: 0 };

  const serialized = (chunks || []).map((chunk) => ({
    sequence: chunk.sequence,
    encryption_version: chunk.encryption_version ?? chunk.version ?? 1,
    ciphertext_base64:
      chunk.ciphertext_base64 ||
      (Buffer.isBuffer(chunk.ciphertext) ? chunk.ciphertext.toString("base64") : null),
  })).filter((c) => c.ciphertext_base64);

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

  let sent = 0;
  const targets =
    message.key_offers instanceof Map && message.key_offers.size > 0
      ? [...message.key_offers.keys()].filter((id) => id !== message.sender_device_id)
      : recipientIdsForMessage(message, message.sender_device_id);

  for (const deviceId of targets) {
    sent += emitToDevice(deviceId, "voice_final", payload);
  }
  return { sent };
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
