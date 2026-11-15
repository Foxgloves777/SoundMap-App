# SoundMap

**Name a song, drop a file or record the room. Get the sonic blueprint and the prompts to rebuild it.**

Live at https://sonicdna.netlify.app · GitHub → Netlify (push to `main` deploys).

## What it does

- **Song** — type a song name (or paste a YouTube link). SoundMap finds it and Gemini *listens to it* from the link. Nothing is downloaded and nothing is written from memory.
- **File** — MP3, WAV, FLAC, M4A, OGG, AAC up to 200 MB. Tempo is measured in the browser from the signal itself.
- **Microphone** — record what's playing in the room.

Every map gives: tempo, key, energy, genre and mood · a timestamped structure timeline · master / medium / short prompts for Suno, Udio and Lyria (no artist or song names) · modifier lines · full production breakdown · instrument palette · genre layers · **Ask about a moment** (click any second, ask what's making that sound).

## Run it locally

```bash
npm install
npm run dev        # http://localhost:4250
```

The Gemini key is read from the environment, then `.env.local`, then `../.env`.

## How it's built

No framework and no build step.

| Path | What |
|---|---|
| `public/` | The whole interface: `index.html`, `styles.css`, `app.js` |
| `lib/core.mjs` | The API: `/api/search`, `/api/upload`, `/api/job`, `/api/ask`, and the mapping job |
| `netlify/functions/api.mjs` | Wraps `lib/core.mjs` as one Netlify Function |
| `netlify/functions/map-background.mjs` | Runs a map as a background job |
| `dev.mjs` | Local server running the same handlers |

Things that look odd but are deliberate (each was a bug first):

- **Two passes.** `listen()` (audio → plain notes) then `shape()` (notes → JSON). Asked to listen *and* fill a JSON schema in one call, Gemini sometimes stops listening and invents a different song.
- **No `temperature` setting.** Lowering it makes current Gemini models hallucinate the audio.
- **Model order** is `gemini-4-argon` first, chosen by test (see the comment in `lib/core.mjs`). Override with `SOUNDMAP_MODEL`.
- **Uploads go browser → Gemini directly.** Netlify Functions cap request bodies near 4.5 MB, so the server only hands out a single-use upload address.
- **M4A / WebM are converted to WAV in the browser.** Gemini doesn't reject them; it makes things up.
- **API version is pinned to `v1beta`.** The `-latest` model aliases 404 on `v1`.

## Netlify

`GEMINI_API_KEY` must be set under Site configuration → Environment variables. Ordinary functions on this site are cut off at 30 seconds (measured), and a map takes 35-50, so mapping runs in `netlify/functions/map-background.mjs` (a Background Function, 15-minute limit) and reports progress through Netlify Blobs, which the page polls at `/api/job`.
