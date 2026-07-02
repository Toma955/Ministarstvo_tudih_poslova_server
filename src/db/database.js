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
    is_base_station INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
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
      device_id, display_name, sender_name, avatar_jpeg_base64, public_key_base64, is_base_station, updated_at
    ) VALUES (
      @device_id, @display_name, @sender_name, @avatar_jpeg_base64, @public_key_base64, @is_base_station, datetime('now')
    )
    ON CONFLICT(device_id) DO UPDATE SET
      display_name = excluded.display_name,
      sender_name = excluded.sender_name,
      avatar_jpeg_base64 = COALESCE(excluded.avatar_jpeg_base64, users.avatar_jpeg_base64),
      public_key_base64 = COALESCE(excluded.public_key_base64, users.public_key_base64),
      is_base_station = excluded.is_base_station,
      updated_at = datetime('now')
  `).run(user);
}

export function listUsers() {
  return db.prepare(`
    SELECT device_id, display_name, sender_name, is_base_station, created_at, updated_at
    FROM users ORDER BY updated_at DESC
  `).all();
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
