import { listDeviceIdsInRoom } from "../db/database.js";
import { SERVER_SENDER_ID } from "../stores/voiceMessageStore.js";
import { sendVoiceMessagePush } from "./apns.js";

export async function notifyVoiceMessageRecipients(message) {
  if (!message?.session_id) return { sent: 0 };

  let recipientIds = [];

  if (message.source_type === "server" || message.plaintext) {
    recipientIds = listDeviceIdsInRoom(message.room_code).filter(
      (id) => id !== message.sender_device_id && id !== SERVER_SENDER_ID
    );
  } else if (message.key_offers instanceof Map) {
    recipientIds = [...message.key_offers.keys()].filter(
      (id) => id !== message.sender_device_id
    );
  } else if (message.key_offers && typeof message.key_offers === "object") {
    recipientIds = Object.keys(message.key_offers).filter(
      (id) => id !== message.sender_device_id
    );
  }

  if (!recipientIds.length) return { sent: 0 };

  return sendVoiceMessagePush({
    deviceIds: recipientIds,
    sessionId: message.session_id,
    senderName: message.sender_name,
    sourceType: message.source_type || "radio",
  });
}
