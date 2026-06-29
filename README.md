# Mock Web Connect Server

A mock WebSocket server that simulates the AIS Web Connect ID card reader device (`wss://localhost:8088/ReadIDCard`). Includes a browser-based control panel to edit card profiles, trigger read events, and clone data from a physical card reader.

---

## Features

- **WebSocket mock** — simulates the full AIS Web Connect event flow (`OnInitialized` → `OnCardInserted` → `OnCardLoadProgress` → `OnCardLoadCompleted`)
- **Control panel UI** — edit ID card profile, upload a custom card photo, manually trigger success/failure events
- **Download / Browse** — export the current profile (with photo) as `.json` or import a saved profile file
- **Clone Real Card** — read data from a physical Thai ID card via PC/SC smart card reader and auto-fill the form

---

## Requirements

- **Node.js** 16+
- **OpenSSL** (for certificate generation — already bundled on macOS/Linux; included in Git for Windows)

### For Clone Real Card (physical reader)

| OS | Requirement |
|---|---|
| Windows | Built-in WinSCard — no extra install needed |
| macOS | Built-in PCSC framework — no extra install needed |
| Linux | `sudo apt install libpcsclite-dev pcscd` |

---

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Start the server (uses pre-generated certs included in the repo)
npm start
```

Then open the control panel in your browser:

```
https://localhost:8088
```

> **First visit:** Your browser will show a security warning because the certificate is self-signed.
> Click **Advanced → Proceed to localhost** to trust it.
> This only needs to be done once.

---

## Regenerating Certificates

The repo ships with a ready-to-use self-signed certificate. If you need to regenerate it (e.g. it expired):

```bash
npm run gen-cert
```

---

## Control Panel

### ID Card Profile

Edit all fields of the mock Thai ID card profile.

| Button | Description |
|---|---|
| **📂 Browse** | Load a previously saved `.json` profile file into the form |
| **⬇️ Download** | Export the current form as a `.json` file |
| **💾 Apply to Server** | Push the current form values to the server — subsequent Read Success triggers will use this profile |

### Actions

| Button | WebSocket events sent |
|---|---|
| **📥 Insert Card** | `OnCardInserted` |
| **✅ Read Success** | `OnCardInserted` → `OnCardLoadProgress` (×5) → `OnCardLoadCompleted` |
| **❌ Read Failed** | `OnCardInserted` → `OnCardLoadError` (with optional custom message) |
| **🔄 Remove Card** | `OnCardRemoved` |
| **🖨️ Clone Real Card** | Activates the physical PC/SC reader (see below) |

### Clone Real Card

1. Plug in a USB smart card reader
2. Click **🖨️ Clone Real Card**
3. The reader status strip updates live:
   - `No reader detected` — reader not plugged in
   - `Reader ready: [name] — insert card` — waiting for card
   - `Reading card...` — reading in progress
   - `Card read!` — profile filled in form automatically
4. After a successful read, the form is auto-filled with the real card data
5. Click **💾 Apply to Server** then trigger **✅ Read Success** to replay it to the Angular app

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/profile` | Get current active profile |
| `POST` | `/api/profile` | Update current profile (JSON body, may include `PhotoImage`) |
| `GET` | `/api/status` | Connection count + last 20 WebSocket events |
| `GET` | `/api/reader-status` | Physical card reader state |
| `POST` | `/api/reader/start` | (Re)start PC/SC reader listener |
| `GET` | `/api/photo` | Get current card photo (base64) |
| `POST` | `/api/photo` | Set card photo (`{ "photo": "<base64>" }`), or reset to default (`{ "reset": true }`) |
| `POST` | `/api/trigger/insert` | Send `OnCardInserted` |
| `POST` | `/api/trigger/success` | Send full read success sequence |
| `POST` | `/api/trigger/failed` | Send `OnCardLoadError` (optional `{ "message": "..." }`) |
| `POST` | `/api/trigger/remove` | Send `OnCardRemoved` |

---

## WebSocket Event Flow

The Angular app connects to `wss://localhost:8088/ReadIDCard`.

```
Client connects
  ← OnInitialized

[Trigger: Read Success]
  ← OnCardInserted
  ← OnCardLoadProgress  { Progress: 20 }
  ← OnCardLoadProgress  { Progress: 40 }
  ← OnCardLoadProgress  { Progress: 60 }
  ← OnCardLoadProgress  { Progress: 80 }
  ← OnCardLoadProgress  { Progress: 100 }
  ← OnCardLoadCompleted { Data: "<base64>", PhotoImage: "<base64>" }

[Trigger: Read Failed]
  ← OnCardInserted
  ← OnCardLoadError     { Message: "..." }
```

`Data` in `OnCardLoadCompleted` is a **base64-encoded UTF-8 JSON** string matching the `mapDataFromAisWebConnect()` field mapping in `read-card.service.ts`.

---

## Profile JSON Format

```json
{
  "NationalID":       "1100100000001",
  "ThaiTitleName":    "นาย",
  "EnglishTitleName": "MR.",
  "ThaiFirstName":    "ทดสอบ",
  "ThaiLastName":     "ระบบ",
  "EnglishFirstName": "THADSOB",
  "EnglishLastName":  "RABOB",
  "Birthdate":        "19900115",
  "Sex":              "1",
  "Address":          "123",
  "Moo":              "หมู่ที่5",
  "Soi":              "ซอยทดสอบ",
  "Thanon":           "ถนนพหลโยธิน",
  "Tumbol":           "ตำบลลาดยาว",
  "Amphur":           "อำเภอจตุจักร",
  "Province":         "จังหวัดกรุงเทพมหานคร",
  "IssueDate":        "20200101",
  "ExpireDate":       "20300101",
  "ChipID":           "0000000000001",
  "RequestNo":        "REQ0000001",
  "LaserID":          "ME1234567890"
}
```

- **Birthdate / IssueDate / ExpireDate** — `YYYYMMDD` format
- **Sex** — `"1"` = Male, `"2"` = Female

---

## Project Structure

```
mock-web-connect-server/
├── server.js        # HTTPS + WebSocket server, REST API
├── card-reader.js   # PC/SC physical card reader (pcsclite)
├── public/
│   └── index.html   # Browser control panel
├── certs/
│   ├── cert.pem     # Self-signed TLS certificate
│   └── key.pem      # Private key
├── package.json
└── .gitignore
```
