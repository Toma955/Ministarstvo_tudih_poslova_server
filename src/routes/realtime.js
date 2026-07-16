import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getUser } from "../db/database.js";
import { attachRealtimeClient, realtimeStats } from "../services/realtime.js";

const router = Router();

/**
 * GET /api/v1/realtime/events
 * Dugovječna SSE veza — server šalje voice_started / voice_chunk / voice_complete / voice_final.
 * Klijent ne polla; samo sluša.
 */
router.get("/events", authMiddleware(), (req, res) => {
  const deviceId = req.auth?.device_id;
  if (!deviceId || req.auth?.role !== "user") {
    return res.status(403).json({ error: "forbidden", message: "Samo korisnički token." });
  }

  const user = getUser(deviceId);
  console.log(
    `[voice] ${new Date().toISOString()} SSE_ROUTE_HIT | device=${String(deviceId).slice(0, 8)}… | room=${user?.room_code || "-"}`
  );
  attachRealtimeClient(res, deviceId, user?.room_code || null);
});

router.get("/stats", authMiddleware("admin"), (_req, res) => {
  res.json(realtimeStats());
});

export default router;
