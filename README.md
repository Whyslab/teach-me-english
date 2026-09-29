# 🇳🇴 Лёгкий Словарь · Norsk — offline-first Norwegian vocabulary trainer

*[Русская версия](README.ru.md)*

![PWA](https://img.shields.io/badge/PWA-installable-5a45ff?style=flat-square)
![Node](https://img.shields.io/badge/Node-20.17%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
[![CI](https://github.com/Whyslab/teach-me-english/actions/workflows/ci.yml/badge.svg)](https://github.com/Whyslab/teach-me-english/actions/workflows/ci.yml)

A self-hosted trainer for **Norwegian (Bokmål)** vocabulary built around spaced repetition. Add a Norwegian word and the app suggests a translation, pulls example sentences, speaks the word with a Norwegian voice, and schedules reviews so you see it again right before you would have forgotten it.

Installable as a PWA and fully usable with no network connection.

> The interface is in Russian — the app is built for Russian speakers learning Norwegian. The codebase and this document are in English.

![The trainer's main screen](./screenshot.png)

---

## ✨ What it does

* **SM-2 spaced repetition** (the Anki algorithm) with four grades — Again, Hard, Good, Easy. Each word's ease factor, interval, repetition count and answer history are persisted server-side.
* **Five training modes:** flashcards, spelling (see the Norwegian word, type the translation — any of several comma-separated translations is accepted), multiple choice, marathon (no timer) and mistakes-only.
* **Norwegian speech.** Browser speech synthesis with an explicitly selected `nb`/`no` voice; the app warns if the OS has none installed.
* **æ ø å buttons** for people without a Norwegian keyboard layout (Shift for capitals).
* **Auto-translation** Norwegian → Russian while adding a word (MyMemory).
* **Example sentences from Tatoeba** — Bokmål ↔ Russian pairs, proxied server-side for CORS.
* **Progress you can see:** per-level learning curve, three-month activity heatmap, seven-day chart, review forecast, XP, streaks, weekly challenge, achievements.
* **Works offline.** A service worker caches the shell; the deck lives in the browser and syncs back when the server is reachable.
* **Your data stays yours:** TXT/CSV/Anki export, full JSON backup and restore, text import.

---

## 🛠️ Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 5 |
| Storage | SQLite (WAL mode) via `sqlite3` |
| Frontend | Vanilla JS, no framework |
| Offline | Service worker + Web App Manifest |
| Hardening | Static file allow-list, `express-rate-limit`, CORS allow-list |

---

## 🚀 Running it

Requires Node.js 20.17 or newer — that is what `sqlite3` 6.x needs.

```bash
git clone https://github.com/Whyslab/teach-me-english.git
cd teach-me-english
npm install
npm start
```

Then open <http://localhost:3000>. `vocab.db` is created on first run; older databases are migrated in place.

> **Note on `npm install`:** `sqlite3` compiles a native binding. Recent npm versions block install scripts by default; if `require('sqlite3')` fails afterwards, run `npm rebuild sqlite3` once.

### Import format

One word per line: `word|translation|example|example translation|tags`. Only the first two fields are required.

```
hus|дом|Huset er stort.|Дом большой.|A1,hjem
eple|яблоко
```

---

## 🔌 API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/words` | The deck, including SM-2 state and answer history |
| `POST` | `/api/sync` | Replace the deck with the client's copy (queued, transactional) |
| `POST` | `/api/register` | Returns the fixed single-user id |
| `GET` | `/api/tatoeba?word=…` | Bokmål → Russian example sentences (CORS proxy) |
| `GET`/`POST` | `/api/timer` | Session timer state |

Only the frontend files (`index.html`, `app.js`, `sw.js`, `manifest.json`, icons) are served statically — the database, sources and deploy scripts are not.

> **There is no authentication.** Every route is open to anything that can reach the port. Fine on `localhost` or a trusted home network; do not port-forward this to the internet.

---

## 🗂️ Data model

```sql
words (
    id, original, translate, example, exampleTranslate,
    level, nextReview, forgetStep, tags,
    sm2EF, sm2Interval, sm2Reps, history, addedAt
)
settings (key, value)
```

Databases created by the earlier English version also carry `videoId`, `startTime`, `endTime`, `subtitleText` and `imageUrl`. They are left in place so the migration is non-destructive, but they are no longer read or written.

---

## 🧪 Tests

```bash
npm install
npm test
```

58 tests, run against a throwaway SQLite file. `tests/api.test.js` covers validation, the sync round-trip (including SM-2 state), concurrent syncs, the static allow-list, the Tatoeba input checks and timer bounds. `tests/client.test.js` covers the pure helpers in `app.js` (escaping, spelling-answer matching) plus static regressions — no duplicate function declarations, every inline handler in `index.html` points at a real function, speech is Norwegian.

CI runs them on Node 20 and 22, plus a static pass that syntax-checks every JavaScript file and asserts every icon the manifest declares exists.

---

## 🚀 Running it as a service

```bash
./deploy/install.sh
```

Checks your Node version, installs dependencies, creates `.env` from `.env.example`, generates a systemd **user** unit (`teach-me-norwegian.service`), starts it and waits for it to answer. No `sudo`. If the old `teach-me-english.service` unit is present, it is stopped and archived first so the two do not fight over the port.

```bash
systemctl --user status teach-me-norwegian
journalctl --user -u teach-me-norwegian -f
./deploy/uninstall.sh      # removes the unit, keeps vocab.db and .env
```

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `127.0.0.1` | Interface to bind. `0.0.0.0` to reach it from your phone |
| `DATABASE_PATH` | `./vocab.db` | Database file, resolved against the application directory |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS allow-list |

---

## 📋 Project documents

* [docs/AUDIT.md](docs/AUDIT.md) — code audit: what was broken and what was fixed (in Russian).
* [docs/ROADMAP.md](docs/ROADMAP.md) — what to add, remove and optimise next (in Russian).

## ⚠️ Known rough edges

* `app.js` is still a single large browser script. Splitting it into modules is the main structural debt.
* `POST /api/sync` replaces the whole table; with two devices the last sync wins.
* The Tatoeba and MyMemory language codes (`nob`, `nb-NO`) follow the services' documentation but were not verified against the live APIs during the migration.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
