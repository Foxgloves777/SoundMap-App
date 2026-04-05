# 🎵 SoundMap

**Drop any audio. Get the sonic blueprint. Paste it into Suno, Udio, or Lyria.**

---

## What it does

SoundMap analyzes any audio file and extracts its complete sonic DNA — then formats it as production-ready AI music generation prompts. Three input methods:

- **📁 Upload** — drag and drop any MP3, WAV, FLAC, M4A, OGG (up to 100MB)
- **▶️ YouTube link** — paste any YouTube URL (up to 20 minutes)
- **🎙️ Record live** — tap to record from your mic or hold it up to a speaker

Output includes:
- Genre DNA table
- Tempo & rhythm breakdown
- Harmonic foundation
- Vocal characteristics
- Instrumentation palette
- Production characteristics
- **Master SoundMap prompt** (copy → paste into Suno/Udio/Lyria)
- Modifier blocks (push specific directions)
- Short/medium/full prompt variants

All output is copyright-safe — no artist names, no song titles.

---

## Running the app

```bash
# Already built and ready. Start it:
cd /home/node/.openclaw/workspace/soundmap-app
GEMINI_API_KEY=your_key npm run start -- -p 3099

# Or use the start script (auto-loads .env.local):
./start.sh
```

## Accessing from outside the server

**Option A: SSH tunnel (fastest)**
```bash
# On your local machine:
ssh -L 3099:localhost:3099 root@66.179.136.102
# Then open: http://localhost:3099
```

**Option B: Open port 3099 in IONOS firewall**
- IONOS Cloud Console → your server → Security Groups → add inbound rule: TCP port 3099
- Then access: http://66.179.136.102:3099

---

## Stack

- Next.js 16 (App Router)
- Tailwind CSS v4
- Gemini 2.5 Flash (audio analysis)
- ytdl-core (YouTube extraction)
- Built by Solomon — April 2026
