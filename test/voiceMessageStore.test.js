import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupTestDatabase } from "./helpers/preload.js";
import {
  createVoiceSession,
  addKeyOffer,
  addEncryptedChunk,
  completeVoiceSession,
  replaceFinalAudio,
  getDeliveryPackage,
  listInboxForDevice,
  createServerBroadcast,
  memoryStats,
  resetVoiceMemoryForTests,
  applyFeedback,
  feedbackState,
  getCompletedMessage,
} from "../src/stores/voiceMessageStore.js";
import { upsertUser, ensureDefaultRoom } from "../src/db/database.js";

function fakeCipher(label) {
  return Buffer.from(`cipher:${label}`, "utf8").toString("base64");
}

describe("voiceMessageStore — slanje / primanje / spremanje", () => {
  beforeEach(() => {
    resetVoiceMemoryForTests();
    ensureDefaultRoom();
    upsertUser({
      device_id: "sender-1",
      display_name: "Sender",
      sender_name: "Sender",
      avatar_jpeg_base64: null,
      public_key_base64: "SENDER_PUB_KEY",
      room_code: "kanal",
      is_base_station: 0,
    });
    upsertUser({
      device_id: "receiver-1",
      display_name: "Receiver",
      sender_name: "Receiver",
      avatar_jpeg_base64: null,
      public_key_base64: "RECEIVER_PUB_KEY",
      room_code: "kanal",
      is_base_station: 0,
    });
  });

  after(() => {
    resetVoiceMemoryForTests();
    cleanupTestDatabase();
  });

  it("kreira sesiju i sprema LQ chunkove", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });

    const afterChunk0 = addEncryptedChunk(sessionId, 0, 1, fakeCipher("lq-0"));
    const afterChunk1 = addEncryptedChunk(sessionId, 1, 1, fakeCipher("lq-1"));

    assert.ok(afterChunk0);
    assert.ok(afterChunk1);
    assert.equal(afterChunk1.chunks.size, 2);
    assert.equal(afterChunk1.sequence, 1);
    assert.equal(memoryStats().active_sessions, 1);
  });

  it("delivery bez key offera vraća key_pending (ne missing)", () => {
    const sessionId = "22222222-2222-2222-2222-222222222222";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    addEncryptedChunk(sessionId, 0, 1, fakeCipher("early"));

    const delivery = getDeliveryPackage(sessionId, "receiver-1");
    assert.equal(delivery.error, undefined);
    assert.equal(delivery.key_pending, true);
    assert.equal(delivery.wrapped_key, null);
    assert.deepEqual(delivery.chunks, []);
  });

  it("key offer + chunkovi → delivery s wrapped_key i ciphertextima", () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    addKeyOffer(sessionId, "receiver-1", 1, fakeCipher("wrap"));
    addEncryptedChunk(sessionId, 0, 1, fakeCipher("a"));
    addEncryptedChunk(sessionId, 1, 1, fakeCipher("b"));

    const delivery = getDeliveryPackage(sessionId, "receiver-1");
    assert.equal(delivery.key_pending, false);
    assert.equal(delivery.wrapped_key.ciphertext_base64, fakeCipher("wrap"));
    assert.equal(delivery.chunks.length, 2);
    assert.equal(delivery.chunks[0].sequence, 0);
    assert.equal(delivery.chunks[1].ciphertext_base64, fakeCipher("b"));
    assert.equal(delivery.is_complete, false);
  });

  it("complete premješta poruku u RAM completed i inbox", () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    addKeyOffer(sessionId, "receiver-1", 1, fakeCipher("wrap"));
    addEncryptedChunk(sessionId, 0, 1, fakeCipher("lq"));

    const completed = completeVoiceSession(sessionId, "Sender", 0);
    assert.ok(completed);
    assert.equal(memoryStats().active_sessions, 0);
    assert.equal(memoryStats().completed_messages, 1);

    const inbox = listInboxForDevice("receiver-1");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].session_id, sessionId);
    assert.equal(inbox[0].is_complete, true);
    assert.equal(inbox[0].audio_quality, "live");

    const delivery = getDeliveryPackage(sessionId, "receiver-1");
    assert.equal(delivery.is_complete, true);
    assert.equal(delivery.has_final_audio, false);
    assert.equal(delivery.chunks.length, 1);
  });

  it("HQ final zamjenjuje LQ chunkove i označi has_final_audio", () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    addKeyOffer(sessionId, "receiver-1", 1, fakeCipher("wrap"));
    addEncryptedChunk(sessionId, 0, 1, fakeCipher("lq-old"));
    completeVoiceSession(sessionId, "Sender", 0);

    const updated = replaceFinalAudio(
      sessionId,
      [
        { sequence: 0, encryption_version: 1, ciphertext_base64: fakeCipher("hq-0") },
        { sequence: 1, encryption_version: 1, ciphertext_base64: fakeCipher("hq-1") },
      ],
      44100
    );

    assert.ok(updated);
    assert.equal(updated.has_final_audio, true);
    assert.equal(updated.audio_quality, "final");
    assert.equal(updated.sample_rate, 44100);
    assert.equal(updated.chunk_count, 2);

    const delivery = getDeliveryPackage(sessionId, "receiver-1");
    assert.equal(delivery.has_final_audio, true);
    assert.equal(delivery.audio_quality, "final");
    assert.equal(delivery.sample_rate, 44100);
    assert.equal(delivery.chunks.length, 2);
    assert.equal(delivery.chunks[0].ciphertext_base64, fakeCipher("hq-0"));
  });

  it("sender ne može skinuti vlastitu poruku", () => {
    const sessionId = "66666666-6666-6666-6666-666666666666";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    const delivery = getDeliveryPackage(sessionId, "sender-1");
    assert.equal(delivery.error, "own_message");
  });

  it("server broadcast sprema plaintext WAV i vidi se u deliveryju", () => {
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const wav = Buffer.concat([Buffer.alloc(44, 0), pcm]);
    wav.write("RIFF", 0);

    createServerBroadcast({
      sessionId,
      roomCode: "kanal",
      senderName: "Centrala",
      wavBuffer: wav,
    });

    const delivery = getDeliveryPackage(sessionId, "receiver-1");
    assert.equal(delivery.is_plaintext, true);
    assert.equal(delivery.source_type, "server");
    assert.equal(delivery.chunks.length, 1);
    assert.equal(delivery.chunks[0].is_plaintext, true);
    assert.equal(
      Buffer.from(delivery.chunks[0].ciphertext_base64, "base64").equals(pcm),
      true
    );
  });

  it("feedback se sprema na completed poruku", () => {
    const sessionId = "88888888-8888-8888-8888-888888888888";
    createVoiceSession({
      sessionId,
      senderDeviceId: "sender-1",
      senderName: "Sender",
      roomCode: "kanal",
    });
    addKeyOffer(sessionId, "receiver-1", 1, fakeCipher("wrap"));
    addEncryptedChunk(sessionId, 0, 1, fakeCipher("lq"));
    completeVoiceSession(sessionId, "Sender", 0);

    applyFeedback(sessionId, {
      kind: "personDelivered",
      actor_peer_key: "receiver-1",
      actor_name: "Receiver",
    });
    applyFeedback(sessionId, {
      kind: "personListened",
      actor_peer_key: "receiver-1",
      actor_name: "Receiver",
    });

    const state = feedbackState(sessionId);
    assert.equal(state.person_feedback.length, 1);
    assert.equal(state.person_feedback[0].is_delivered, true);
    assert.equal(state.person_feedback[0].is_listened, true);
    assert.ok(getCompletedMessage(sessionId));
  });
});
