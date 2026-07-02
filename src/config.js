import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8080),
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-me-please-use-long-secret",
  jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN || 86400),
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  maxVoiceMessages: Number(process.env.MAX_VOICE_MESSAGES || 10),
  databasePath: process.env.DATABASE_PATH || "./data/mk-server.db",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  apiVersion: 1,
  defaultRoomCode: (process.env.DEFAULT_ROOM_CODE || "kanal").trim().toLowerCase(),
  defaultRoomTitle: process.env.DEFAULT_ROOM_TITLE || "Glavni kanal",
  apns: {
    keyId: process.env.APNS_KEY_ID || "",
    teamId: process.env.APNS_TEAM_ID || "",
    bundleId: process.env.APNS_BUNDLE_ID || "TomaPrivate.Ministarstvo-Komunikacija",
    keyPath: process.env.APNS_KEY_PATH || "",
    keyP8: process.env.APNS_KEY_P8 || "",
    production: process.env.APNS_PRODUCTION === "true",
  },
};
