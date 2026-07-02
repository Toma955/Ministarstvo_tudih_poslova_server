import express from "express";
import cors from "cors";
import morgan from "morgan";
import { config } from "./config.js";
import { apiVersionMiddleware } from "./middleware/auth.js";

import authRoutes from "./routes/auth.js";
import profileRoutes from "./routes/profile.js";
import messageRoutes from "./routes/messages.js";
import publicRoutes from "./routes/public.js";
import adminRoutes from "./routes/admin.js";
import { memoryStats } from "./stores/voiceMessageStore.js";

const app = express();

app.use(morgan("dev"));
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
  });
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/profile", profileRoutes);
app.use("/api/v1/messages", messageRoutes);
app.use("/api/v1", publicRoutes);
app.use("/admin", adminRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found", message: "Ruta ne postoji." });
});

app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "internal_error", message: "Interna greška servera." });
});

app.listen(config.port, () => {
  console.log(`[server] Slušam na portu ${config.port}`);
  console.log(`[server] Admin: ${config.adminUsername} (postavi ADMIN_PASSWORD u produkciji)`);
  console.log(`[server] Max glasovnih poruka u RAM-u: ${config.maxVoiceMessages}`);
});
