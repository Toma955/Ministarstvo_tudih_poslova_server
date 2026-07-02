import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { getUser } from "../db/database.js";

/** @typedef {{ version: number, ciphertext: Buffer, plaintext?: boolean }} EncryptedChunk */

export const SERVER_SENDER_ID = "__server__";
export const SOURCE_TYPES = new Set(["base", "radio", "server"]);

const activeSessions = new Map();
const completedMessages = [];

function normalizeFeedbackKind(kind) {
  const map = {
    personDelivered: "person_delivered",
    personListened: "person_listened",
    personLike: "person_like",
    baseSeen: "base_seen",
    baseListened: "base_listened",
    baseLike: "base_like",
  };
  return map[kind] || kind;
}

function normalizeSourceType(value, fallback = "radio") {
  if (typeof value === "string" && SOURCE_TYPES.has(value)) {
    return value;
  }
  return fallback;
}

function pcmFromWavBuffer(wavBuffer) {
  if (!wavBuffer || wavBuffer.length <= 44) return Buffer.alloc(0);
  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
    return wavBuffer;
  }
  return wavBuffer.subarray(44);
}

function serializeChunks(chunksMap, plaintext = false) {
  return [...chunksMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sequence, chunk]) => ({
      sequence,
      encryption_version: chunk.version ?? 0,
      ciphertext_base64: chunk.ciphertext.toString("base64"),
      is_plaintext: plaintext || Boolean(chunk.plaintext),
    }));
}

function trimCompletedMessages() {
  while (completedMessages.length > config.maxVoiceMessages) {
    completedMessages.pop();
  }
}

function inboxItemFromMessage(message, isComplete) {
  return {
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    room_code: message.room_code || null,
    chunk_count: message.chunk_count ?? message.chunks?.size ?? 0,
    sequence: message.sequence,
    created_at: message.created_at,
    completed_at: message.completed_at || null,
    is_complete: isComplete,
  };
}

export function createVoiceSession({
  sessionId,
  senderDeviceId,
  senderName,
  sourceType = "radio",
  roomCode = null,
}) {
  activeSessions.set(sessionId, {
    session_id: sessionId,
    sender_device_id: senderDeviceId,
    sender_name: senderName,
    source_type: normalizeSourceType(sourceType),
    room_code: roomCode || null,
    sequence: 0,
    chunks: new Map(),
    key_offers: new Map(),
    created_at: new Date().toISOString(),
    completed: false,
    plaintext: false,
  });
  return activeSessions.get(sessionId);
}

export function createServerBroadcast({ sessionId, roomCode, senderName, wavBuffer }) {
  const pcm = pcmFromWavBuffer(wavBuffer);
  const chunks = new Map();

  if (pcm.length > 0) {
    chunks.set(0, {
      version: 0,
      ciphertext: pcm,
      plaintext: true,
    });
  }

  const message = {
    session_id: sessionId,
    sender_device_id: SERVER_SENDER_ID,
    sender_name: senderName || "Centrala",
    source_type: "server",
    room_code: roomCode,
    sequence: 0,
    chunks,
    key_offers: new Map(),
    chunk_count: chunks.size,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    base_feedback: null,
    person_feedback: [],
    plaintext: true,
    wav_data: wavBuffer,
  };

  completedMessages.unshift(message);
  trimCompletedMessages();
  return message;
}

export function getActiveSession(sessionId) {
  return activeSessions.get(sessionId);
}

export function getMessageRecord(sessionId) {
  return getActiveSession(sessionId) || getCompletedMessage(sessionId);
}

export function addKeyOffer(sessionId, recipientDeviceId, encryptionVersion, ciphertextBase64) {
  const message = getMessageRecord(sessionId);
  if (!message || message.plaintext) return null;

  if (!message.key_offers) {
    message.key_offers = new Map();
  }

  message.key_offers.set(recipientDeviceId, {
    version: encryptionVersion,
    ciphertext_base64: ciphertextBase64,
  });

  return message;
}

export function addEncryptedChunk(sessionId, sequence, encryptionVersion, ciphertextBase64) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  if (session.completed || session.plaintext) return null;

  const ciphertext = Buffer.from(ciphertextBase64, "base64");
  session.chunks.set(sequence, {
    version: encryptionVersion,
    ciphertext,
  });
  session.sequence = Math.max(session.sequence, sequence);
  return session;
}

export function completeVoiceSession(sessionId, senderName, sequence) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  session.completed = true;
  session.sender_name = senderName || session.sender_name;
  session.sequence = Math.max(session.sequence, sequence);
  session.completed_at = new Date().toISOString();

  const message = {
    session_id: sessionId,
    sender_device_id: session.sender_device_id,
    sender_name: session.sender_name,
    source_type: session.source_type || "radio",
    room_code: session.room_code || null,
    sequence: session.sequence,
    chunks: session.chunks,
    key_offers: session.key_offers || new Map(),
    chunk_count: session.chunks.size,
    created_at: session.created_at,
    completed_at: session.completed_at,
    base_feedback: null,
    person_feedback: [],
    plaintext: Boolean(session.plaintext),
    wav_data: null,
  };

  activeSessions.delete(sessionId);
  completedMessages.unshift(message);
  trimCompletedMessages();

  return message;
}

export function getCompletedMessage(sessionId) {
  return completedMessages.find((m) => m.session_id === sessionId) || null;
}

export function getAdminMessageAudio(sessionId) {
  const message = getCompletedMessage(sessionId);
  if (!message?.wav_data) return null;
  return message.wav_data;
}

function recipientCanSeeMessage(message, deviceId, userRoom) {
  if (message.sender_device_id === deviceId) return false;

  if (message.source_type === "server") {
    return Boolean(userRoom && message.room_code === userRoom);
  }

  if (message.key_offers?.has(deviceId)) return true;
  return Boolean(userRoom && message.room_code && message.room_code === userRoom);
}

export function listInboxForDevice(deviceId) {
  const user = getUser(deviceId);
  const userRoom = user?.room_code || null;
  const items = [];

  for (const session of activeSessions.values()) {
    if (!recipientCanSeeMessage(session, deviceId, userRoom)) continue;
    items.push(inboxItemFromMessage(session, false));
  }

  for (const message of completedMessages) {
    if (!recipientCanSeeMessage(message, deviceId, userRoom)) continue;
    items.push(inboxItemFromMessage(message, true));
  }

  return items.sort((a, b) => {
    const aTime = a.completed_at || a.created_at;
    const bTime = b.completed_at || b.created_at;
    return bTime.localeCompare(aTime);
  });
}

export function getDeliveryPackage(sessionId, recipientDeviceId) {
  const message = getMessageRecord(sessionId);
  if (!message) return null;
  if (message.sender_device_id === recipientDeviceId) return null;

  const user = getUser(recipientDeviceId);
  const userRoom = user?.room_code || null;

  if (message.source_type === "server" || message.plaintext) {
    if (!userRoom || message.room_code !== userRoom) return null;

    return {
      session_id: sessionId,
      sender_device_id: message.sender_device_id,
      sender_name: message.sender_name,
      source_type: "server",
      sequence: message.sequence,
      is_complete: Boolean(message.completed_at || message.completed),
      is_plaintext: true,
      wrapped_key: null,
      chunks: serializeChunks(message.chunks, true),
    };
  }

  if (!userRoom || message.room_code !== userRoom) return null;

  const keyOffer = message.key_offers?.get(recipientDeviceId);
  if (!keyOffer) return null;

  return {
    session_id: sessionId,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    sequence: message.sequence,
    is_complete: Boolean(message.completed_at || message.completed),
    is_plaintext: false,
    wrapped_key: {
      encryption_version: keyOffer.version,
      ciphertext_base64: keyOffer.ciphertext_base64,
    },
    chunks: serializeChunks(message.chunks),
  };
}

export function listCompletedMessages() {
  return completedMessages.map((message) => ({
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    source_type: message.source_type || "radio",
    room_code: message.room_code || null,
    chunk_count: message.chunk_count,
    sequence: message.sequence,
    created_at: message.created_at,
    completed_at: message.completed_at,
    key_offer_count: message.key_offers?.size || 0,
    person_feedback_count: message.person_feedback.length,
    has_base_feedback: Boolean(message.base_feedback),
    has_audio: Boolean(message.wav_data),
    is_complete: true,
  }));
}

export function listActiveSessionsForAdmin() {
  return [...activeSessions.values()].map((session) => ({
    session_id: session.session_id,
    sender_device_id: session.sender_device_id,
    sender_name: session.sender_name,
    source_type: session.source_type || "radio",
    room_code: session.room_code || null,
    chunk_count: session.chunks?.size ?? 0,
    sequence: session.sequence,
    created_at: session.created_at,
    completed_at: null,
    key_offer_count: session.key_offers?.size || 0,
    person_feedback_count: 0,
    has_base_feedback: false,
    has_audio: false,
    is_complete: false,
  }));
}

export function deleteCompletedMessage(sessionId) {
  const index = completedMessages.findIndex((m) => m.session_id === sessionId);
  if (index === -1) return false;
  completedMessages.splice(index, 1);
  return true;
}

export function purgeUserFromMemory(deviceId) {
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.sender_device_id === deviceId) {
      activeSessions.delete(sessionId);
    }
  }

  for (let i = completedMessages.length - 1; i >= 0; i -= 1) {
    const message = completedMessages[i];
    if (message.sender_device_id === deviceId) {
      completedMessages.splice(i, 1);
      continue;
    }

    if (message.key_offers?.has(deviceId)) {
      message.key_offers.delete(deviceId);
    }
  }
}

export function applyFeedback(sessionId, payload) {
  const message = getCompletedMessage(sessionId);
  if (!message) return null;

  const kind = normalizeFeedbackKind(payload.kind);
  const isBase = payload.is_base_account || kind.startsWith("base_");

  if (isBase) {
    message.base_feedback = message.base_feedback || {
      is_seen: false,
      is_listened: false,
      is_liked: false,
    };

    switch (kind) {
      case "base_seen":
        message.base_feedback.is_seen = true;
        break;
      case "base_listened":
        message.base_feedback.is_listened = true;
        break;
      case "base_like":
        message.base_feedback.is_liked = true;
        break;
      default:
        break;
    }
  } else {
    const peerKey = payload.actor_peer_key || payload.actorPeerKey || "unknown";
    const displayName = payload.actor_name || payload.actorName || peerKey;
    let person = message.person_feedback.find((p) => p.peer_key === peerKey);

    if (!person) {
      person = {
        peer_key: peerKey,
        display_name: displayName,
        is_delivered: false,
        is_listened: false,
        is_liked: false,
      };
      message.person_feedback.push(person);
    }

    person.display_name = displayName || person.display_name;

    switch (kind) {
      case "person_delivered":
        person.is_delivered = true;
        break;
      case "person_listened":
        person.is_delivered = true;
        person.is_listened = true;
        break;
      case "person_like":
        person.is_liked = true;
        break;
      default:
        break;
    }
  }

  return feedbackState(sessionId);
}

export function feedbackState(sessionId) {
  const message = getCompletedMessage(sessionId);
  if (!message) {
    return {
      session_id: sessionId,
      base_feedback: null,
      person_feedback: [],
    };
  }

  return {
    session_id: sessionId,
    base_feedback: message.base_feedback,
    person_feedback: message.person_feedback,
  };
}

export function purgeStaleActiveSessions(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [sessionId, session] of activeSessions.entries()) {
    const createdAt = Date.parse(session.created_at || "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff) {
      activeSessions.delete(sessionId);
      removed += 1;
    }
  }

  return removed;
}

export function memoryStats() {
  return {
    active_sessions: activeSessions.size,
    completed_messages: completedMessages.length,
    max_voice_messages: config.maxVoiceMessages,
  };
}

export { uuidv4 };
