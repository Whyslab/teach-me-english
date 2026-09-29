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

* **SM-2 spaced repetition** (the Anki algorithm), grades on keys 1–4. Ease, interval, repetitions and answer history are persisted server-side.
* **A daily new-word limit** (15 by default, like Anki). Reviews are never capped, so importing a large deck does not turn into a review avalanche a week later.
* **Grammar:** noun gender (`en` / `ei` / `et`, colour-coded) and inflections — *et hus — huset — hus — husene*, *å reise — reiser — reiste — har reist*. A "⚡ regular forms" button fills in the regular patterns.
* **Training modes:** flashcards · writing NO→RU · writing RU→NO · multiple choice · **guess the gender** · **inflection drill** · hard words · marathon (no limit).
* **A bundled Norsk A1 deck** — 275 high-frequency words with gender, forms, example sentences and Russian translations, one click in the Import dialog (`decks/a1.txt`, plain import format).
* **Pronunciation:** browser speech with an `nb-NO` voice, plus links to [Forvo](https://forvo.com/languages/no/) (native speakers) and [Ordbøkene](https://ordbokene.no/) (the official Bokmål dictionary).
* **æ ø å buttons**; answers that are right except for the special letters are flagged separately.
* **Auto-translation** Norwegian → Russian and **Tatoeba examples** (Bokmål ↔ Russian).
* **Stats:** streak with a daily goal, review forecast, level curve, activity heatmap, hard words, per-word history.
* **Offline PWA**, TXT/CSV/Anki export, JSON backup and restore, **4 themes** (system, dark, light, Nord).

---

## 🛠️ Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 5 |
| Storage | SQLite (WAL mode) via `sqlite3` |
| Frontend | Native ES modules in `js/`, no framework, no bundler |
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

One word per line: `word|translation|example|example translation|tags|gender|forms`. Only the first two fields are required. Gender is `en`/`ei`/`et` for nouns or `v` for verbs; forms are comma-separated (noun: definite singular, indefinite plural, definite plural; verb: present, past, perfect). TXT export writes the same format.

```
hus|дом|Huset er stort.|Дом большой.|A1,hjem|et|huset,hus,husene
å reise|путешествовать||||v|reiser,reiste,har reist
eple|яблоко
```

---

## 🔌 API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/words` | The deck, including SM-2 state and answer history |
| `POST` | `/api/sync` | Replace the deck with the client's copy (queued, transactional) |
| `GET` | `/api/tatoeba?word=…` | Bokmål → Russian example sentences (CORS proxy) |

Only the frontend is served statically — `index.html`, `sw.js`, `manifest.json`, icons, and files matching `js/*.js`, `css/*.css`, `decks/*.txt` (flat names only). The database, server sources and deploy scripts are not.

> **There is no authentication.** Every route is open to anything that can reach the port. Fine on `localhost` or a trusted home network; do not port-forward this to the internet.

---

## 🗂️ Data model

```sql
words (
    id, original, translate, example, exampleTranslate,
    level, nextReview, forgetStep, tags,
    sm2EF, sm2Interval, sm2Reps, history, addedAt,
    pos, gender, forms            -- part of speech, en/ei/et, JSON of inflections
)
```

Databases created by the earlier English version also carry `videoId`, `startTime`, `endTime`, `subtitleText`, `imageUrl` and a `settings` table for the removed daily timer. They are left in place so the migration is non-destructive, but they are no longer read or written.

---

## 🧪 Tests

```bash
npm install
npm test
```

72 tests, run against a throwaway SQLite file. `tests/api.test.js` covers validation, the sync round-trip (SM-2 state, gender and forms), concurrent syncs, the static allow-list including traversal attempts, and the Tatoeba input checks. `tests/client.test.js` imports the DOM-free modules directly — SM-2, session selection with the new-word limit, answer checking (articles, æ ø å, alternative translations), regular-form guessing, the import/export format, the A1 deck's integrity — and adds static checks on the markup: every `data-action` has a handler, every looked-up id exists, no inline handlers or scripts, and the service worker precaches every module.

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

* `POST /api/sync` replaces the whole table; with two devices the last sync wins.
* The Tatoeba and MyMemory language codes (`nob`, `nb-NO`) follow the services' documentation but were not verified against the live APIs during the migration.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
