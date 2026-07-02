import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { signToken, authMiddleware } from "../middleware/auth.js";
import {
  getAdminByUsername,
  listUsers,
  getUser,
  setAppSetting,
  getAppSetting,
} from "../db/database.js";
import {
  listCompletedMessages,
  deleteCompletedMessage,
  memoryStats,
  getCompletedMessage,
} from "../stores/voiceMessageStore.js";

const router = Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "invalid_request", message: "username i password su obavezni." });
  }

  const admin = getAdminByUsername(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: "unauthorized", message: "Pogrešni podaci za prijavu." });
  }

  const token = signToken({
    role: "admin",
    admin_id: admin.id,
    username: admin.username,
  });

  res.json({
    access_token: token,
    expires_in: config.jwtExpiresIn,
    username: admin.username,
  });
});

router.get("/me", authMiddleware("admin"), (req, res) => {
  res.json({
    username: req.auth.username,
    role: "admin",
  });
});

router.get("/stats", authMiddleware("admin"), (_req, res) => {
  const users = listUsers();
  res.json({
    users_count: users.length,
    memory: memoryStats(),
  });
});

router.get("/users", authMiddleware("admin"), (_req, res) => {
  res.json({ users: listUsers() });
});

router.get("/users/:deviceId", authMiddleware("admin"), (req, res) => {
  const user = getUser(req.params.deviceId);
  if (!user) {
    return res.status(404).json({ error: "not_found", message: "Korisnik nije pronađen." });
  }

  res.json({ user });
});

router.get("/messages", authMiddleware("admin"), (_req, res) => {
  res.json({ messages: listCompletedMessages() });
});

router.get("/messages/:sessionId", authMiddleware("admin"), (req, res) => {
  const message = getCompletedMessage(req.params.sessionId);
  if (!message) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije u memoriji." });
  }

  res.json({
    session_id: message.session_id,
    sender_device_id: message.sender_device_id,
    sender_name: message.sender_name,
    chunk_count: message.chunk_count,
    sequence: message.sequence,
    created_at: message.created_at,
    completed_at: message.completed_at,
    base_feedback: message.base_feedback,
    person_feedback: message.person_feedback,
  });
});

router.delete("/messages/:sessionId", authMiddleware("admin"), (req, res) => {
  const deleted = deleteCompletedMessage(req.params.sessionId);
  if (!deleted) {
    return res.status(404).json({ error: "not_found", message: "Poruka nije u memoriji." });
  }
  res.json({ ok: true });
});

router.get("/settings/operating-status", authMiddleware("admin"), (_req, res) => {
  res.json(getAppSetting("operating_status", {}));
});

router.put("/settings/operating-status", authMiddleware("admin"), (req, res) => {
  const body = req.body || {};
  const current = getAppSetting("operating_status", {});

  const next = {
    is_operational:
      typeof body.is_operational === "boolean"
        ? body.is_operational
        : Boolean(current.is_operational ?? true),
    message: typeof body.message === "string" ? body.message : current.message || "",
    resumes_at: body.resumes_at ?? current.resumes_at ?? null,
    working_hours_label:
      typeof body.working_hours_label === "string"
        ? body.working_hours_label
        : current.working_hours_label || null,
  };

  setAppSetting("operating_status", next);
  res.json(next);
});

router.get("/settings/system-message", authMiddleware("admin"), (_req, res) => {
  res.json(getAppSetting("system_message", {}));
});

router.put("/settings/system-message", authMiddleware("admin"), (req, res) => {
  const body = req.body || {};
  const current = getAppSetting("system_message", {});
  const allowedSeverity = new Set(["info", "warning", "error"]);

  const next = {
    is_active:
      typeof body.is_active === "boolean"
        ? body.is_active
        : Boolean(current.is_active ?? false),
    title: body.title !== undefined ? body.title : current.title ?? null,
    message: typeof body.message === "string" ? body.message : current.message || "",
    severity: allowedSeverity.has(body.severity)
      ? body.severity
      : current.severity || "info",
  };

  setAppSetting("system_message", next);
  res.json(next);
});

export default router;
