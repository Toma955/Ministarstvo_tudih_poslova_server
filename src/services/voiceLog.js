//
// Konzolni logovi za glasovni kanal — lako praćenje u Render/terminalu.
//

import { listDeviceIdsInRoom, getUser } from "../db/database.js";

export function shortId(value) {
  if (!value) return "-";
  const text = String(value);
  return text.length <= 8 ? text : `${text.slice(0, 8)}…`;
}

export function roomSnapshot(roomCode) {
  if (!roomCode) {
    return { room: null, users_in_room: 0, device_ids: [] };
  }
  const deviceIds = listDeviceIdsInRoom(roomCode);
  return {
    room: roomCode,
    users_in_room: deviceIds.length,
    device_ids: deviceIds.map(shortId),
  };
}

export function voiceLog(tag, details = {}) {
  const ts = new Date().toISOString();
  const parts = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}=[${v.join(",")}]`;
      if (v && typeof v === "object") return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    });
  console.log(`[voice] ${ts} ${tag}${parts.length ? ` | ${parts.join(" | ")}` : ""}`);
}

export function logRoomState(tag, roomCode, extra = {}) {
  voiceLog(tag, {
    ...roomSnapshot(roomCode),
    ...extra,
  });
}

export function logDeviceRoom(tag, deviceId, extra = {}) {
  const user = getUser(deviceId);
  logRoomState(tag, user?.room_code || null, {
    device: shortId(deviceId),
    name: user?.sender_name || user?.display_name || null,
    ...extra,
  });
}
