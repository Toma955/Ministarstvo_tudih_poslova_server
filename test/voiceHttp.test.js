import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupTestDatabase } from "./helpers/preload.js";
import { createApp } from "../src/app.js";
import { resetVoiceMemoryForTests } from "../src/stores/voiceMessageStore.js";
import { ensureDefaultRoom } from "../src/db/database.js";

function fakeKey(label) {
  return Buffer.from(label.padEnd(32, "0"), "utf8").toString("base64");
}

function fakeCipher(label) {
  return Buffer.from(`cipher:${label}`, "utf8").toString("base64");
}

describe("HTTP voice — join → send → receive → HQ save", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    ensureDefaultRoom();
    const app = createApp({ quiet: true });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    resetVoiceMemoryForTests();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupTestDatabase();
  });

  beforeEach(() => {
    resetVoiceMemoryForTests();
  });

  async function join(deviceId, publicKeyLabel) {
    const res = await fetch(`${baseUrl}/api/v1/rooms/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_code: "kanal",
        device_id: deviceId,
        public_key_base64: fakeKey(publicKeyLabel),
        display_name: deviceId,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.access_token);
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

  it("pun LQ + HQ flow između dva uređaja", async () => {
    const senderToken = await join("http-sender", "sender-pub");
    const receiverToken = await join("http-receiver", "receiver-pub");

    const peers = await api(senderToken, "/api/v1/users/peers");
    assert.equal(peers.status, 200);
    assert.ok(peers.json.peers.some((p) => p.device_id === "http-receiver"));
    assert.ok(
      peers.json.peers.find((p) => p.device_id === "http-receiver")?.public_key_base64
    );

    const created = await api(senderToken, "/api/v1/messages", {
      method: "POST",
      body: { sender_name: "Sender HTTP" },
    });
    assert.equal(created.status, 201);
    const sessionId = created.json.session_id;
    assert.ok(sessionId);

    const pending = await api(receiverToken, `/api/v1/messages/${sessionId}/delivery`);
    assert.equal(pending.status, 200);
    assert.equal(pending.json.key_pending, true);
    assert.equal(pending.json.chunks.length, 0);

    const keys = await api(senderToken, `/api/v1/messages/${sessionId}/key-offers`, {
      method: "POST",
      body: {
        offers: [
          {
            recipient_device_id: "http-receiver",
            encryption_version: 1,
            ciphertext_base64: fakeCipher("wrap-http"),
          },
        ],
      },
    });
    assert.equal(keys.status, 200);
    assert.equal(keys.json.count, 1);

    const chunk0 = await api(senderToken, `/api/v1/messages/${sessionId}/chunks`, {
      method: "POST",
      body: {
        sequence: 0,
        encryption_version: 1,
        ciphertext_base64: fakeCipher("lq-0"),
      },
    });
    const chunk1 = await api(senderToken, `/api/v1/messages/${sessionId}/chunks`, {
      method: "POST",
      body: {
        sequence: 1,
        encryption_version: 1,
        ciphertext_base64: fakeCipher("lq-1"),
      },
    });
    assert.equal(chunk0.status, 200);
    assert.equal(chunk1.status, 200);

    const liveDelivery = await api(receiverToken, `/api/v1/messages/${sessionId}/delivery`);
    assert.equal(liveDelivery.status, 200);
    assert.equal(liveDelivery.json.key_pending, false);
    assert.ok(liveDelivery.json.wrapped_key);
    assert.equal(liveDelivery.json.chunks.length, 2);
    assert.equal(liveDelivery.json.is_complete, false);
    assert.equal(liveDelivery.json.has_final_audio, false);

    const complete = await api(senderToken, `/api/v1/messages/${sessionId}/complete`, {
      method: "POST",
      body: { sequence: 1, sender_name: "Sender HTTP" },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.json.chunk_count, 2);

    const inbox = await api(receiverToken, "/api/v1/messages/inbox");
    assert.equal(inbox.status, 200);
    assert.ok(inbox.json.messages.some((m) => m.session_id === sessionId && m.is_complete));

    const hq = await api(senderToken, `/api/v1/messages/${sessionId}/final`, {
      method: "POST",
      body: {
        sample_rate: 44100,
        chunks: [
          {
            sequence: 0,
            encryption_version: 1,
            ciphertext_base64: fakeCipher("hq-0"),
          },
          {
            sequence: 1,
            encryption_version: 1,
            ciphertext_base64: fakeCipher("hq-1"),
          },
        ],
      },
    });
    assert.equal(hq.status, 200, JSON.stringify(hq.json));
    assert.equal(hq.json.has_final_audio, true);
    assert.equal(hq.json.audio_quality, "final");
    assert.equal(hq.json.sample_rate, 44100);

    const finalDelivery = await api(receiverToken, `/api/v1/messages/${sessionId}/delivery`);
    assert.equal(finalDelivery.status, 200);
    assert.equal(finalDelivery.json.has_final_audio, true);
    assert.equal(finalDelivery.json.audio_quality, "final");
    assert.equal(finalDelivery.json.sample_rate, 44100);
    assert.equal(finalDelivery.json.chunks.length, 2);
    assert.equal(finalDelivery.json.chunks[0].ciphertext_base64, fakeCipher("hq-0"));

    const feedback = await api(receiverToken, `/api/v1/messages/${sessionId}/feedback`, {
      method: "POST",
      body: {
        kind: "personDelivered",
        actor_peer_key: "http-receiver",
        actor_name: "Receiver",
      },
    });
    assert.equal(feedback.status, 200);

    const feedbackGet = await api(receiverToken, `/api/v1/messages/${sessionId}/feedback`);
    assert.equal(feedbackGet.status, 200);
    assert.ok(
      feedbackGet.json.person_feedback?.some(
        (p) => p.peer_key === "http-receiver" && p.is_delivered
      )
    );
  });

  it("health pokazuje memory stats nakon sesije", async () => {
    const senderToken = await join("http-health-sender", "health-sender");
    await join("http-health-receiver", "health-receiver");

    const created = await api(senderToken, "/api/v1/messages", {
      method: "POST",
      body: { sender_name: "Health" },
    });
    assert.equal(created.status, 201);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.ok(body.memory.active_sessions >= 1);
  });
});
