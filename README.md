# Ministarstvo Financija Server

Node.js backend za **Ministarstvo Komunikacija** iOS app. SQLite baza za korisnike i admin postavke; glasovne poruke se drže u RAM-u (max 10).

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

**Napomena:** SQLite datoteka na Render free tieru nije trajna između redeploya. Za produkciju razmotri persistent disk ili PostgreSQL.

## iOS app

U appu uključi server u `ChannelServerConfiguration`:

- `isEnabled: true`
- `baseURL`: URL tvog Render servisa (npr. `https://mk-komunikacija-server.onrender.com`)

Pri startu pozovi `registerDevice` s `device_id` i javnim ključem.

## API — korisnici (`/api/v1`)

| Metoda | Putanja | Auth |
|--------|---------|------|
| POST | `/auth/register` | ne |
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

### Registracija uređaja

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "device_id": "UUID-uređaja",
  "public_key_base64": "...",
  "display_name": "Ime"
}
```

Odgovor: `{ "access_token": "...", "expires_in": 86400 }`

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
- **App na spavanje** — gasi iOS app (`operating-status`)  
- sistemska obavijest (banner u appu)

## Glasovne poruke u RAM-u

- Aktivne sesije (snimanje u tijeku) + max **10** završenih poruka
- Starije se automatski brišu kad dođe 11.
- Chunkovi su enkriptirani (`ciphertext_base64`); server ih ne dešifrira.
- Admin može pregledati metapodatke i obrisati poruku iz memorije.

## Health check

`GET /health` — za Render monitoring.
