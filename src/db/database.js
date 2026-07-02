import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { config } from "../config.js";

const dataDir = path.dirname(config.databasePath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    device_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT 'Nepoznato',
    avatar_jpeg_base64 TEXT,
    public_key_base64 TEXT,
    room_code TEXT,
    is_base_station INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    room_code TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(config.adminUsername);
  if (existing) return;

  const hash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run(
    config.adminUsername,
    hash
  );
  console.log(`[db] Admin kreiran: ${config.adminUsername}`);
}

function ensureDefaultAppSettings() {
  const defaults = {
    operating_status: {
      is_operational: true,
      message: "",
      resumes_at: null,
      working_hours_label: "pon–pet 07:00–19:00",
    },
    system_message: {
      is_active: false,
      title: null,
      message: "",
      severity: "info",
      blocks_app: false,
    },
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value_json) VALUES (?, ?)"
  );

  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, JSON.stringify(value));
  }
}

ensureAdmin();
ensureDefaultAppSettings();
ensureUserColumns();

function ensureUserColumns() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  if (!columns.some((col) => col.name === "room_code")) {
    db.exec("ALTER TABLE users ADD COLUMN room_code TEXT");
  }
}

export function getAppSetting(key, fallback) {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

export function setAppSetting(key, value) {
  db.prepare(
    "INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  ).run(key, JSON.stringify(value));
}

export function getUser(deviceId) {
  return db.prepare("SELECT * FROM users WHERE device_id = ?").get(deviceId);
}

export function upsertUser(user) {
  db.prepare(`
    INSERT INTO users (
      device_id, display_name, sender_name, avatar_jpeg_base64, public_key_base64, room_code, is_base_station, updated_at
    ) VALUES (
      @device_id, @display_name, @sender_name, @avatar_jpeg_base64, @public_key_base64, @room_code, @is_base_station, datetime('now')
    )
    ON CONFLICT(device_id) DO UPDATE SET
      display_name = excluded.display_name,
      sender_name = excluded.sender_name,
      avatar_jpeg_base64 = COALESCE(excluded.avatar_jpeg_base64, users.avatar_jpeg_base64),
      public_key_base64 = COALESCE(excluded.public_key_base64, users.public_key_base64),
      room_code = COALESCE(excluded.room_code, users.room_code),
      is_base_station = excluded.is_base_station,
      updated_at = datetime('now')
  `).run(user);
}

export function listUsers() {
  return db.prepare(`
    SELECT device_id, display_name, sender_name, room_code, public_key_base64, is_base_station, created_at, updated_at
    FROM users ORDER BY updated_at DESC
  `).all();
}

export function listPeerUsers(excludeDeviceId, roomCode) {
  if (!roomCode) return [];

  return db.prepare(`
    SELECT device_id, display_name, sender_name, public_key_base64, is_base_station
    FROM users
    WHERE device_id != ?
      AND room_code = ?
      AND public_key_base64 IS NOT NULL
      AND public_key_base64 != ''
    ORDER BY updated_at DESC
  `).all(excludeDeviceId, roomCode);
}

export function normalizeRoomCode(roomCode) {
  if (typeof roomCode !== "string") return null;
  const normalized = roomCode.trim().toLowerCase();
  if (!normalized || normalized.length < 2 || normalized.length > 32) return null;
  if (!/^[a-z0-9\-_]+$/.test(normalized)) return null;
  return normalized;
}

export function getRoom(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return null;
  return db.prepare("SELECT * FROM rooms WHERE room_code = ?").get(normalized);
}

export function listRooms() {
  return db
    .prepare(`
      SELECT
        r.room_code,
        r.title,
        r.is_active,
        r.created_at,
        (
          SELECT COUNT(*)
          FROM users u
          WHERE u.room_code = r.room_code
        ) AS member_count
      FROM rooms r
      ORDER BY r.created_at DESC
    `)
    .all()
    .map((row) => ({
      room_code: row.room_code,
      title: row.title || "",
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
      member_count: row.member_count,
    }));
}

export function createRoom({ roomCode, title = "" }) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return { error: "invalid_format" };
  if (getRoom(normalized)) return { error: "already_exists" };

  db.prepare(
    "INSERT INTO rooms (room_code, title, is_active) VALUES (?, ?, 1)"
  ).run(normalized, typeof title === "string" ? title.trim() : "");

  return { room: getRoom(normalized) };
}

export function setRoomActive(roomCode, isActive) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized || !getRoom(normalized)) return null;

  db.prepare("UPDATE rooms SET is_active = ? WHERE room_code = ?").run(
    isActive ? 1 : 0,
    normalized
  );

  return getRoom(normalized);
}

export function deleteRoom(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return { error: "invalid_format" };

  const room = getRoom(normalized);
  if (!room) return { error: "not_found" };

  const memberCount = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE room_code = ?")
    .get(normalized).count;

  if (memberCount > 0) {
    return { error: "not_empty", member_count: memberCount };
  }

  db.prepare("DELETE FROM rooms WHERE room_code = ?").run(normalized);
  return { ok: true };
}

export function joinRoom({ deviceId, roomCode, publicKeyBase64, displayName }) {
  const normalizedRoom = normalizeRoomCode(roomCode);
  if (!normalizedRoom) return { error: "invalid_format" };

  const room = getRoom(normalizedRoom);
  if (!room) return { error: "not_found" };
  if (!room.is_active) return { error: "inactive" };

  const existing = getUser(deviceId);
  const name = typeof displayName === "string" ? displayName.trim() : "";

  upsertUser({
    device_id: deviceId,
    display_name: name || existing?.display_name || "",
    sender_name: name || existing?.sender_name || "Nepoznato",
    avatar_jpeg_base64: existing?.avatar_jpeg_base64 || null,
    public_key_base64: publicKeyBase64 || existing?.public_key_base64 || null,
    room_code: normalizedRoom,
    is_base_station: existing?.is_base_station || 0,
  });

  return { user: getUser(deviceId) };
}

export function deleteUser(deviceId) {
  const result = db.prepare("DELETE FROM users WHERE device_id = ?").run(deviceId);
  return result.changes > 0;
}

export function getAdminByUsername(username) {
  return db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
}

export function initialsFromName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function profileResponseFromRow(row) {
  const displayName = row.display_name || "";
  const senderName = row.sender_name || displayName || "Nepoznato";
  return {
    display_name: displayName,
    sender_name: senderName,
    avatar_jpeg_base64: row.avatar_jpeg_base64 || null,
    is_base_station: Boolean(row.is_base_station),
    initials: initialsFromName(displayName || senderName),
  };
}
