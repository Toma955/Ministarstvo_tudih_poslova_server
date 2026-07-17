import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getUser, upsertUser } from "../db/database.js";

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

/**
 * Nakon Render redeploya SQLite može biti prazan dok JWT još ima room_code.
 * Vrati membership iz tokena da peers/inbox/voice rade.
 */
function ensureUserRoomFromToken(auth) {
  if (!auth || auth.role !== "user" || !auth.device_id) return;
  const roomFromToken =
    typeof auth.room_code === "string" ? auth.room_code.trim().toLowerCase() : null;
  if (!roomFromToken) return;

  const existing = getUser(auth.device_id);
  if (existing?.room_code) return;

  upsertUser({
    device_id: auth.device_id,
    display_name: existing?.display_name || "Korisnik",
    sender_name: existing?.sender_name || existing?.display_name || "Korisnik",
    avatar_jpeg_base64: existing?.avatar_jpeg_base64 || null,
    public_key_base64: existing?.public_key_base64 || null,
    room_code: roomFromToken,
    is_base_station: existing?.is_base_station || 0,
  });

  console.log(
    `[voice] ${new Date().toISOString()} ROOM_RESTORED_FROM_JWT | device=${String(auth.device_id).slice(0, 8)}… | room=${roomFromToken}`
  );
}

export function authMiddleware(requiredRole = null) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");

    if (!token) {
      return res.status(401).json({ error: "unauthorized", message: "Nedostaje token." });
    }

    try {
      const decoded = verifyToken(token);
      req.auth = decoded;

      if (requiredRole && decoded.role !== requiredRole) {
        return res.status(403).json({ error: "forbidden", message: "Nedovoljna prava." });
      }

      ensureUserRoomFromToken(decoded);
      next();
    } catch {
      return res.status(401).json({ error: "unauthorized", message: "Token nije valjan." });
    }
  };
}

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  if (token) {
    try {
      req.auth = verifyToken(token);
    } catch {
      req.auth = null;
    }
  }
  next();
}

export function apiVersionMiddleware(req, res, next) {
  res.setHeader("X-MK-API-Version", String(config.apiVersion));
  next();
}
