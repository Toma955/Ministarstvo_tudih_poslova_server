import http2 from "http2";
import jwt from "jsonwebtoken";
import fs from "fs";
import { config } from "../config.js";
import { getPushTokensForDevices } from "../db/database.js";

let cachedJwt = null;
let cachedJwtExpiresAt = 0;

function apnsEnabled() {
  return Boolean(
    config.apns.keyId &&
      config.apns.teamId &&
      config.apns.bundleId &&
      (config.apns.keyPath || config.apns.keyP8)
  );
}

function loadPrivateKey() {
  if (config.apns.keyP8) {
    return config.apns.keyP8.replace(/\\n/g, "\n");
  }
  if (config.apns.keyPath && fs.existsSync(config.apns.keyPath)) {
    return fs.readFileSync(config.apns.keyPath, "utf8");
  }
  return null;
}

function authToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwtExpiresAt - 120 > now) {
    return cachedJwt;
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) return null;

  cachedJwt = jwt.sign({}, privateKey, {
    algorithm: "ES256",
    issuer: config.apns.teamId,
    expiresIn: "50m",
    header: {
      alg: "ES256",
      kid: config.apns.keyId,
    },
  });
  cachedJwtExpiresAt = now + 50 * 60;
  return cachedJwt;
}

function sendToDevice(deviceToken, payload) {
  return new Promise((resolve) => {
    const token = authToken();
    if (!token) {
      resolve({ ok: false, reason: "apns_not_configured" });
      return;
    }

    const host = config.apns.production
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";

    const client = http2.connect(`https://${host}`);
    const body = JSON.stringify(payload);
    const path = `/3/device/${deviceToken}`;

    const req = client.request({
      ":method": "POST",
      ":path": path,
      authorization: `bearer ${token}`,
      "apns-topic": config.apns.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });

    let statusCode = 0;
    let responseData = "";

    req.on("response", (headers) => {
      statusCode = Number(headers[":status"] || 0);
    });
    req.on("data", (chunk) => {
      responseData += chunk;
    });
    req.on("end", () => {
      client.close();
      const ok = statusCode === 200;
      if (!ok) {
        console.warn("[apns] push failed", statusCode, responseData);
      }
      resolve({ ok, status: statusCode, body: responseData });
    });
    req.on("error", (error) => {
      client.close();
      console.warn("[apns] request error", error.message);
      resolve({ ok: false, reason: error.message });
    });

    req.write(body);
    req.end();
  });
}

export function isApnsConfigured() {
  return apnsEnabled();
}

export async function sendVoiceMessagePush({ deviceIds, sessionId, senderName, sourceType }) {
  if (!apnsEnabled() || !deviceIds?.length) return { sent: 0 };

  const tokens = getPushTokensForDevices(deviceIds);
  if (!tokens.length) return { sent: 0 };

  const title =
    sourceType === "server" ? "Obavijest centra" : "Nova glasovna poruka";
  const body = senderName ? `Od: ${senderName}` : "Nova poruka u kanalu";

  let sent = 0;
  for (const row of tokens) {
    const payload = {
      aps: {
        alert: { title, body },
        sound: "default",
        "content-available": 1,
      },
      session_id: sessionId,
      type: "voice_message",
    };

    const result = await sendToDevice(row.apns_token, payload);
    if (result.ok) sent += 1;
  }

  return { sent };
}
