import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  getUser,
  upsertUser,
  profileResponseFromRow,
} from "../db/database.js";

const router = Router();

function requireUser(req, res) {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
    return null;
  }
  return deviceId;
}

router.get("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const user = getUser(deviceId);
  if (!user) {
    return res.status(404).json({ error: "not_found", message: "Korisnik nije pronađen." });
  }

  res.json(profileResponseFromRow(user));
});

router.put("/", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { display_name: displayName, avatar_jpeg_base64: avatarBase64 } = req.body || {};
  const existing = getUser(deviceId);

  const name = typeof displayName === "string" ? displayName.trim() : existing?.display_name || "";

  upsertUser({
    device_id: deviceId,
    display_name: name,
    sender_name: name || existing?.sender_name || "Nepoznato",
    avatar_jpeg_base64:
      typeof avatarBase64 === "string" ? avatarBase64 : existing?.avatar_jpeg_base64 || null,
    public_key_base64: existing?.public_key_base64 || null,
    room_code: existing?.room_code ?? null,
    is_base_station: existing?.is_base_station || 0,
  });

  res.json(profileResponseFromRow(getUser(deviceId)));
});

router.patch("/base-station", authMiddleware(), (req, res) => {
  const deviceId = requireUser(req, res);
  if (!deviceId) return;

  const { is_base_station: isBaseStation } = req.body || {};
  if (typeof isBaseStation !== "boolean") {
    return res.status(400).json({
      error: "invalid_request",
      message: "is_base_station mora biti boolean.",
    });
  }

  const existing = getUser(deviceId);
  if (!existing) {
    return res.status(404).json({ error: "not_found", message: "Korisnik nije pronađen." });
  }

  upsertUser({
    device_id: deviceId,
    display_name: existing.display_name,
    sender_name: existing.sender_name,
    avatar_jpeg_base64: existing.avatar_jpeg_base64,
    public_key_base64: existing.public_key_base64,
    room_code: existing.room_code ?? null,
    is_base_station: isBaseStation ? 1 : 0,
  });

  res.json(profileResponseFromRow(getUser(deviceId)));
});

export default router;
