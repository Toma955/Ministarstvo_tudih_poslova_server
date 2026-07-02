import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getUser, listPeerUsers } from "../db/database.js";

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

  const peers = listPeerUsers(deviceId, user.room_code).map((peer) => ({
    device_id: peer.device_id,
    display_name: peer.display_name,
    sender_name: peer.sender_name,
    public_key_base64: peer.public_key_base64,
    is_base_station: Boolean(peer.is_base_station),
  }));

  res.json({ peers, room_code: user.room_code });
});

export default router;
