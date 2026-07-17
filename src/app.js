import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { apiVersionMiddleware } from "./middleware/auth.js";

import accountRoutes from "./routes/account.js";
import authRoutes from "./routes/auth.js";
import profileRoutes from "./routes/profile.js";
import userRoutes from "./routes/users.js";
import roomRoutes from "./routes/rooms.js";
import messageRoutes from "./routes/messages.js";
import deviceRoutes from "./routes/devices.js";
import realtimeRoutes from "./routes/realtime.js";
import publicRoutes from "./routes/public.js";
import adminRoutes from "./routes/admin.js";
import { memoryStats } from "./stores/voiceMessageStore.js";
import { isApnsConfigured } from "./services/apns.js";
import { realtimeStats } from "./services/realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPanelPath = path.join(__dirname, "../public/admin/index.html");

export function createApp({ quiet = false } = {}) {
  const app = express();

  if (!quiet) {
    app.use(morgan("dev"));
  }
  app.use(express.json({ limit: "10mb" }));
  app.use(
    cors({
      origin: config.corsOrigin === "*" ? true : config.corsOrigin,
      exposedHeaders: ["X-MK-API-Version"],
    })
  );
  app.use(apiVersionMiddleware);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ministarstvo-komunikacija-server",
      api_version: config.apiVersion,
      memory: memoryStats(),
      realtime: realtimeStats(),
      default_room: config.defaultRoomCode,
      apns_configured: isApnsConfigured(),
    });
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(adminPanelPath);
  });

  app.use("/api/v1/account", accountRoutes);
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/rooms", roomRoutes);
  app.use("/api/v1/profile", profileRoutes);
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/messages", messageRoutes);
  app.use("/api/v1/devices", deviceRoutes);
  app.use("/api/v1/realtime", realtimeRoutes);
  app.use("/api/v1", publicRoutes);
  app.use("/admin", adminRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "Ruta ne postoji." });
  });

  app.use((err, _req, res, _next) => {
    console.error("[error]", err);
    res.status(500).json({ error: "internal_error", message: "Interna greška servera." });
  });

  return app;
}
