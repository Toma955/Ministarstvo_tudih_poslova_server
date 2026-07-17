import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupTestDatabase } from "./helpers/preload.js";
import { createApp } from "../src/app.js";
import { resetVoiceMemoryForTests } from "../src/stores/voiceMessageStore.js";
import { ensureDefaultRoom, getUser, createRoom } from "../src/db/database.js";
import { signToken } from "../src/middleware/auth.js";
import { progressReset, progressStep, progressOk, progressDone } from "./helpers/progress.js";

function fakeKey(label) {
  return Buffer.from(label.padEnd(32, "0"), "utf8").toString("base64");
}

describe("HTTP session / room kick / profile fanout", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {string} */
  let adminToken;

  before(async () => {
    progressReset("session / room kick / profile");
    progressStep("Pokrećem test server…");
    ensureDefaultRoom();
    createRoom({ roomCode: "kickme", title: "Kick test" });
    const app = createApp({ quiet: true });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    progressOk(`Server live ${baseUrl}`);

    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    // Admin login path may differ — try API
    if (!login.ok) {
      const alt = await fetch(`${baseUrl}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin123" }),
      });
      if (alt.ok) {
        const body = await alt.json();
        adminToken = body.access_token || body.token;
      } else {
        // Sign admin token directly for tests
        adminToken = signToken({ role: "admin", username: "admin" });
      }
    } else {
      const body = await login.json();
      adminToken = body.access_token || body.token;
    }
    if (!adminToken) {
      adminToken = signToken({ role: "admin", username: "admin" });
    }
    progressOk("Admin token spreman");
  });

  after(async () => {
    progressStep("Cleanup…");
    resetVoiceMemoryForTests();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupTestDatabase();
    progressDone("session / room kick / profile");
  });

  beforeEach(() => {
    resetVoiceMemoryForTests();
  });

  async function join(deviceId, room = "kanal") {
    const res = await fetch(`${baseUrl}/api/v1/rooms/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_code: room,
        device_id: deviceId,
        public_key_base64: fakeKey(deviceId),
        display_name: deviceId,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.access_token;
  }

  async function api(token, path, { method = "GET", body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  it("GET /rooms/session potvrđuje aktivnu sesiju", async () => {
    const token = await join("sess-ok");
    const session = await api(token, "/api/v1/rooms/session");
    assert.equal(session.status, 200);
    assert.equal(session.json.room_code, "kanal");
    assert.equal(session.json.room_active, true);
  });

  it("brisanje kanala izbacuje članove i session vraća 404", async () => {
    ensureDefaultRoom();
    createRoom({ roomCode: "tempdel", title: "Temp" });
    const token = await join("victim-del", "tempdel");

    const before = await api(token, "/api/v1/rooms/session");
    assert.equal(before.status, 200);

    const del = await api(adminToken, "/admin/rooms/tempdel", { method: "DELETE" });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(del.json.ok, true);

    const user = getUser("victim-del");
    assert.equal(user?.room_code ?? null, null);

    const after = await api(token, "/api/v1/rooms/session");
    assert.equal(after.status, 404);
    assert.ok(
      ["no_membership", "room_missing"].includes(after.json.reason),
      JSON.stringify(after.json)
    );
  });

  it("PUT profile šalje ime/avatar i peers ih vide", async () => {
    const a = await join("prof-a");
    const b = await join("prof-b");

    const tinyJpeg =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z";

    const put = await api(a, "/api/v1/profile", {
      method: "PUT",
      body: {
        display_name: "Alpha Jedinica",
        avatar_jpeg_base64: tinyJpeg,
      },
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.display_name || put.json.sender_name, "Alpha Jedinica");

    const peers = await api(b, "/api/v1/users/peers");
    assert.equal(peers.status, 200);
    const peerA = peers.json.peers.find((p) => p.device_id === "prof-a");
    assert.ok(peerA, "peer A missing");
    assert.equal(peerA.sender_name, "Alpha Jedinica");
    assert.ok(peerA.avatar_jpeg_base64);
  });
});
