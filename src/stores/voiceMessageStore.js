import { config } from "../config.js";

/** @typedef {{ version: number, ciphertext: Buffer }} EncryptedChunk */
/** @typedef {{ peer_key: string, display_name: string, is_delivered: boolean, is_listened: boolean, is_liked: boolean }} PersonFeedback */
/** @typedef {{ is_seen: boolean, is_listened: boolean, is_liked: boolean }} BaseFeedback */

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

export function createVoiceSession({ sessionId, senderDeviceId, senderName }) {
  activeSessions.set(sessionId, {
    session_id: sessionId,
    sender_device_id: senderDeviceId,
    sender_name: senderName,
    sequence: 0,
    chunks: new Map(),
    created_at: new Date().toISOString(),
    completed: false,
  });
  return activeSessions.get(sessionId);
}

export function getActiveSession(sessionId) {
  return activeSessions.get(sessionId);
}

export function addEncryptedChunk(sessionId, sequence, encryptionVersion, ciphertextBase64) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  if (session.completed) return null;

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
    sequence: session.sequence,
    chunks: session.chunks,
    chunk_count: session.chunks.size,
    created_at: session.created_at,
    completed_at: session.completed_at,
    base_feedback: null,
    person_feedback: [],
  };

  activeSessions.delete(sessionId);
  completedMessages.unshift(message);

  while (completedMessages.length > config.maxVoiceMessages) {
    completedMessages.pop();
  }

  return message;
}

export function getCompletedMessage(sessionId) {
  return completedMessages.find((m) => m.session_id === sessionId) || null;
}

export function listCompletedMessages() {
  return completedMessages.map((message) => ({
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    chunk_count: message.chunk_count,
    sequence: message.sequence,
    created_at: message.created_at,
    completed_at: message.completed_at,
    person_feedback_count: message.person_feedback.length,
    has_base_feedback: Boolean(message.base_feedback),
  }));
}

export function deleteCompletedMessage(sessionId) {
  const index = completedMessages.findIndex((m) => m.session_id === sessionId);
  if (index === -1) return false;
  completedMessages.splice(index, 1);
  return true;
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

export function memoryStats() {
  return {
    active_sessions: activeSessions.size,
    completed_messages: completedMessages.length,
    max_voice_messages: config.maxVoiceMessages,
  };
}
