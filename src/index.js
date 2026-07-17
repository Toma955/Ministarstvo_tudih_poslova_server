import { createApp } from "./app.js";
import { config } from "./config.js";
import { purgeStaleActiveSessions } from "./stores/voiceMessageStore.js";
import { isApnsConfigured } from "./services/apns.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] Slušam na portu ${config.port}`);
  console.log(`[server] Admin panel: http://localhost:${config.port}/admin`);
  console.log(`[server] Admin login: ${config.adminUsername}`);
  console.log(`[server] Max glasovnih poruka u RAM-u: ${config.maxVoiceMessages}`);
  console.log(`[server] Default kanal: ${config.defaultRoomCode}`);
  console.log(`[server] APNs: ${isApnsConfigured() ? "uključen" : "nije konfiguriran"}`);

  setInterval(() => {
    const removed = purgeStaleActiveSessions();
    if (removed > 0) {
      console.log(`[cleanup] Uklonjeno zastarjelih aktivnih sesija: ${removed}`);
    }
  }, 5 * 60 * 1000);
});
