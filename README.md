# Ministarstvo Financija Server

Node.js backend za **Ministarstvo Komunikacija** iOS app. SQLite baza za korisnike i admin postavke; glasovne poruke se drže u RAM-u (max 10).

**Jedan kanal:** admin upravlja jednim operativnim kanalom (`DEFAULT_ROOM_CODE`, default: `kanal`). Korisnik u appu **ručno unosi naziv kanala** koji dobije od administracije — nema stotina soba.

**Push obavijesti (APNs):** kad stigne nova glasovna poruka, server šalje push primateljima u kanalu (telefon koji spava dobije obavijest).

## Pokretanje lokalno

```bash
cd Ministarstvo\ Financija_server
cp .env.example .env
npm install
npm run dev
```

Server: `http://localhost:8080`  
**Admin panel:** `http://localhost:8080/admin` (login: `admin` / lozinka iz `.env`)

## Deploy na Render

1. Push repozitorij na GitHub
2. Render → New Web Service → poveži repo
3. Koristi `render.yaml` ili ručno:
   - Build: `npm install`
   - Start: `npm start`
4. Postavi env varijable:
   - `JWT_SECRET` (generiraj dugi random string)
   - `ADMIN_PASSWORD` (jaka lozinka)
   - `CORS_ORIGIN` (opcionalno)
   - `DEFAULT_ROOM_CODE` (default: `kanal`)
   - `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (sadržaj .p8 ključa, s `\n` za nove redove)
   - `APNS_BUNDLE_ID` (`TomaPrivate.Ministarstvo-Komunikacija`)
   - `APNS_PRODUCTION` (`true` za App Store, inače sandbox)

**Napomena:** SQLite datoteka na Render free tieru nije trajna između redeploya. Za produkciju razmotri persistent disk ili PostgreSQL.

## iOS app

U appu je server uključen preko `ChannelServerConfiguration` (`isEnabled: true`, Render URL). Korisnik unosi **naziv kanala** (npr. `kanal`) pri prvom spajanju; sesija se pamti na uređaju.

Za push na fizičkom uređaju u Xcodeu uključi **Push Notifications** capability (entitlements već sadrže `aps-environment`).

## API — korisnici (`/api/v1`)

| Metoda | Putanja | Auth |
|--------|---------|------|
| POST | `/rooms/join` | ne — korisnik šalje `room_code` |
| GET | `/rooms/config` | ne |
| PUT | `/devices/push-token` | Bearer (user) |
| GET | `/profile` | Bearer (user) |
| PUT | `/profile` | Bearer (user) |
| PATCH | `/profile/base-station` | Bearer (user) |
| GET | `/operating-status` | ne |
| GET | `/system-message` | ne |
| POST | `/messages` | Bearer (user) |
| POST | `/messages/:id/chunks` | Bearer (user) |
| POST | `/messages/:id/complete` | Bearer (user) |
| POST | `/messages/:id/key-offers` | Bearer (user) |
| GET | `/messages/inbox` | Bearer (user) |
| GET | `/messages/:id/delivery` | Bearer (user) |
| GET | `/users/peers` | Bearer (user) |
| DELETE | `/account` | Bearer (user) — briše vlastiti račun |
| POST/GET | `/messages/:id/feedback` | Bearer (user) |

Header: `X-MK-API-Version: 1`, `Authorization: Bearer <token>`

### Spajanje na kanal

```http
POST /api/v1/rooms/join
Content-Type: application/json

{
  "device_id": "UUID-uređaja",
  "public_key_base64": "...",
  "room_code": "kanal"
}
```

`room_code` je opcionalan — ako ga nema, koristi se `DEFAULT_ROOM_CODE` s servera.

Odgovor: `{ "access_token": "...", "room_code": "kanal", ... }`

## API — admin (`/admin`)

| Metoda | Putanja |
|--------|---------|
| POST | `/login` |
| GET | `/me`, `/stats`, `/users`, `/messages` |
| GET | `/users/:deviceId`, `/messages/:sessionId` |
| DELETE | `/users/:deviceId`, `/messages/:sessionId` |
| GET/PUT | `/settings/operating-status` |
| GET/PUT | `/settings/system-message` |

Admin login:

```http
POST /admin/login
{ "username": "admin", "password": "..." }
```

### Modus nerada

```http
PUT /admin/settings/operating-status
Authorization: Bearer <admin-token>

{
  "is_operational": false,
  "message": "Aplikacija ne radi izvan radnog vremena.",
  "resumes_at": "2026-07-02T07:00:00.000Z",
  "working_hours_label": "pon–pet 07:00–19:00"
}
```

### Sistemska poruka

```http
PUT /admin/settings/system-message

{
  "is_active": true,
  "title": "Obavijest",
  "message": "Planirano održavanje večeras.",
  "severity": "warning"
}
```

## E2E enkripcija preko servera

Server **ne dešifrira** audio — drži samo ciphertext i omotane session ključeve:

1. `GET /users/peers` — javni P256 ključevi ostalih uređaja  
2. `POST /messages` — nova sesija  
3. `POST /messages/:id/key-offers` — pošiljatelj šalje ECDH-om omotane ključeve po `recipient_device_id`  
4. `POST chunks` + `complete` — enkriptirani audio  
5. Primatelj: `GET /messages/inbox` → `GET /messages/:id/delivery` (wrapped_key + chunks + sender public key)

iOS helperi: `deliverSessionKeyOffersToAllPeers`, `downloadAndDecryptMessage`.

## Web admin panel

Otvori `/admin` u browseru:

- prijava adminom  
- pregled korisnika + brisanje  
- **Glavni kanal** — uključi/isključi jedan operativni kanal  
- slanje glasovne poruke s centrala (push na mobitele)  
- **App na spavanje** — gasi iOS app (`operating-status`)  
- sistemska obavijest (banner u appu)

## Glasovne poruke u RAM-u

- Aktivne sesije (snimanje u tijeku) + max **10** završenih poruka
- Starije se automatski brišu kad dođe 11.
- Chunkovi su enkriptirani (`ciphertext_base64`); server ih ne dešifrira.
- Admin može pregledati metapodatke i obrisati poruku iz memorije.

## Health check

`GET /health` — za Render monitoring.
