# 📚 Лёгкий Словарь — offline-first English vocabulary trainer

![PWA](https://img.shields.io/badge/PWA-installable-5a45ff?style=flat-square)
![Node](https://img.shields.io/badge/Node-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

A self-hosted vocabulary trainer built around spaced repetition. Add an English word, and the app attaches the things that actually make a word stick — a translation, an example sentence, an illustration, and a clip of a real YouTube video where the word is spoken — then schedules reviews so you see it again right before you would have forgotten it.

Installable as a PWA and fully usable with no network connection.

> The interface is in Russian, since it is built for Russian speakers learning English. The codebase and this document are in English.

![The trainer's main screen](./screenshot.png)

---

## ✨ What it does

* **Six-level spaced repetition.** Every word carries a `level`, a `nextReview` timestamp and a `forgetStep`. Answer correctly and the interval grows; miss it and the word drops back down and returns sooner.
* **Words in context, not in isolation.** Each entry can hold an example sentence with its translation, an image, and a YouTube fragment (`videoId` + `startTime`/`endTime` + the subtitle line) so you hear the word in real speech.
* **Example sentences from Tatoeba.** Proxied server-side to work around CORS.
* **Progress you can see.** Learning curve per level, a three-month activity heatmap, a seven-day progress chart, a review forecast, XP and weekly challenges.
* **Works offline.** A service worker caches the shell and assets; the deck lives in the browser and syncs back to the server when it can.
* **Your data stays yours.** Export, backup, restore and import are all built in — the deck is a file you own, not a subscription.
* **Tagging and filtering** by level or by your own tags.

---

## 🛠️ Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 5 |
| Storage | SQLite (WAL mode) via `sqlite3` |
| Frontend | Vanilla JS, no framework |
| Offline | Service worker + Web App Manifest |
| Hardening | `express-rate-limit`, CORS allow-list |
| Tooling | Python scripts for mapping words to video fragments |

---

## 🚀 Running it

Requires Node.js 18 or newer.

```bash
git clone https://github.com/Whyslab/teach-me-english.git
cd teach-me-english
npm install
npm start
```

Then open <http://localhost:3000>.

`vocab.db` is created automatically on first run — there is no migration step. To install the app properly, open it in a browser and use "Install app" / "Add to Home Screen".

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS allow-list. Set this if you serve the app from another host. |

The port is `3000`, set in `server.js`.

> **Note on `npm install`:** `sqlite3` compiles a native binding. Recent npm versions block install scripts by default; if `require('sqlite3')` fails afterwards, run `npm rebuild sqlite3` once.

---

## 🔌 API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/words` | The caller's deck |
| `POST` | `/api/sync` | Push local changes back to the server |
| `POST` | `/api/register` | Create a user id |
| `GET` | `/api/tatoeba?word=…` | Example sentences (CORS proxy) |
| `GET` | `/api/word-image?word=…` | Illustration for a word |
| `GET` | `/api/youglish-proxy` | Pronunciation lookup |
| `GET`/`POST` | `/api/timer` | Session timer state |

Requests carry the caller's id in an `X-User-Id` header. Rate limited to 100 requests per 15 minutes per IP.

---

## 🗂️ Data model

```sql
words (
    id, original, translate, example, exampleTranslate,
    level, nextReview, forgetStep, tags,
    videoId, startTime, endTime, subtitleText, imageUrl
)
settings (key, value)
```

`level`, `nextReview` and `forgetStep` are the scheduler; the `video*` and `imageUrl` columns are what turn a flashcard into something memorable.

---

## 🧰 `tools/`

Python helpers used to build the video-backed entries — locating a word inside a video's subtitles (`youtube_fragment_mapper.py`), then trimming and refining the fragment boundaries (`trim_segments.py`, `refine_segments.py`). They are offline utilities, not part of the running service.

---

## ⚠️ Known rough edges

* `app.js` is a single 147 KB file. It works, but splitting it into modules is the main thing this project needs next.
* No automated tests.
* The repository history still carries a committed `node_modules` from early on, so a clone is heavier than the code warrants.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
