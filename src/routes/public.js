import { Router } from "express";
import { getAppSetting } from "../db/database.js";

const router = Router();

router.get("/operating-status", (_req, res) => {
  const status = getAppSetting("operating_status", {
    is_operational: true,
    message: "",
    resumes_at: null,
    working_hours_label: null,
  });

  res.json({
    is_operational: Boolean(status.is_operational),
    message: status.message || "",
    resumes_at: status.resumes_at || null,
    working_hours_label: status.working_hours_label || null,
  });
});

router.get("/system-message", (_req, res) => {
  const message = getAppSetting("system_message", {
    is_active: false,
    title: null,
    message: "",
    severity: "info",
  });

  res.json({
    is_active: Boolean(message.is_active),
    title: message.title || null,
    message: message.message || "",
    severity: message.severity || "info",
    blocks_app: Boolean(message.blocks_app),
  });
});

export default router;
