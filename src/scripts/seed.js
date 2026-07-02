import { config } from "../config.js";
import { setAppSetting } from "../db/database.js";

setAppSetting("operating_status", {
  is_operational: true,
  message: "",
  resumes_at: null,
  working_hours_label: "pon–pet 07:00–19:00",
});

setAppSetting("system_message", {
  is_active: true,
  title: "Test obavijest",
  message: "Server je spreman za iOS app.",
  severity: "info",
});

console.log("[seed] Postavke ažurirane.");
console.log(`[seed] Admin login: ${config.adminUsername} / ${config.adminPassword}`);
