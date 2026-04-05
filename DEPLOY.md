# 🚀 Deploy SoundMap to Netlify

**2 steps. 5 minutes.**

---

## Step 1 — Push to GitHub

This folder (`soundmap-app/`) is your repo root. Push it to a new GitHub repo:

```bash
# From inside the soundmap-app folder:
git init
git add .
git commit -m "Initial SoundMap"
git remote add origin https://github.com/YOUR_USERNAME/soundmap.git
git push -u origin main
```

---

## Step 2 — Deploy on Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. Connect to GitHub → select your `soundmap` repo
3. Build settings (auto-detected from `netlify.toml`):
   - **Build command:** `npm run build`
   - **Publish directory:** `.next`
4. **CRITICAL — Add environment variable:**
   - Go to **Site Settings → Environment Variables → Add variable**
   - Key: `GEMINI_API_KEY`
   - Value: your Google Gemini API key
5. Click **Deploy**

Done. Netlify handles everything else.

---

## Notes

- **YouTube downloads** — works for tracks up to 10 minutes
- **File uploads** — works up to 20MB (standard quality MP3 ≈ 5 min per 5MB)
- **Recording** — works on any device with a mic
- **API key** — get yours free at [aistudio.google.com](https://aistudio.google.com) → API Keys
- **Redeploy** — push a new commit to GitHub → Netlify auto-deploys

---

## Local development

```bash
# Install deps
npm install --include=dev

# Add your key
cp .env.example .env.local
# Edit .env.local with your GEMINI_API_KEY

# Start dev server
npm run dev

# Or start built version
npm run build && npm run start
```
