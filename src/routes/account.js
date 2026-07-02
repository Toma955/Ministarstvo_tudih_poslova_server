import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { deleteUser, getUser } from "../db/database.js";
import { purgeUserFromMemory } from "../stores/voiceMessageStore.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.delete("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  if (!user) {
    return res.status(404).json({ error: "not_found", message: "Račun nije pronađen." });
  }

  purgeUserFromMemory(deviceId);
  const deleted = deleteUser(deviceId);
  if (!deleted) {
    return res.status(404).json({ error: "not_found", message: "Račun nije pronađen." });
  }

  res.json({ ok: true });
});

export default router;
