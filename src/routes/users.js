import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getUser, listPeerUsers, listDeviceIdsInRoom, profileResponseFromRow } from "../db/database.js";
import { voiceLog, shortId } from "../services/voiceLog.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.get("/peers", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  if (!user?.room_code) {
    return res.status(403).json({ error: "forbidden", message: "Niste u sobi." });
  }

  const roomMembers = listDeviceIdsInRoom(user.room_code);
  const peers = listPeerUsers(deviceId, user.room_code).map((peer) => ({
    device_id: peer.device_id,
    display_name: peer.display_name,
    sender_name: peer.sender_name,
    avatar_jpeg_base64: peer.avatar_jpeg_base64 || null,
    initials: profileResponseFromRow(peer).initials,
    public_key_base64: peer.public_key_base64,
    is_base_station: Boolean(peer.is_base_station),
  }));

  voiceLog("PEERS", {
    device: shortId(deviceId),
    room: user.room_code,
    users_in_room: roomMembers.length,
    peers_with_keys: peers.length,
    missing_keys: Math.max(roomMembers.length - 1 - peers.length, 0),
  });

  res.json({
    peers,
    room_code: user.room_code,
    users_in_room: roomMembers.length,
    peers_with_keys: peers.length,
  });
});

export default router;
