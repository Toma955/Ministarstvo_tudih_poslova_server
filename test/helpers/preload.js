import fs from "fs";
import os from "os";
import path from "path";

const dbPath = path.join(
  os.tmpdir(),
  `mk-voice-test-${process.pid}-${Date.now()}.db`
);

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = dbPath;
process.env.JWT_SECRET = "test-jwt-secret-voice-suite";
process.env.PORT = "0";
process.env.MAX_VOICE_MESSAGES = "10";
process.env.DEFAULT_ROOM_CODE = "kanal";

export function testDatabasePath() {
  return dbPath;
}

export function cleanupTestDatabase() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}
