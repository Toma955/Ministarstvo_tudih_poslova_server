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
};
