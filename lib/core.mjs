// SoundMap API. Every handler takes a web Request and returns a web Response,
// so the same code runs in a Netlify Function and in the local dev server.
//
// Nothing here downloads or stores audio:
//   · YouTube sources are heard by Gemini directly from the link.
//   · Uploads go from the browser straight to Gemini's file store (they would
//     not fit through a Netlify Function, which caps request bodies near 4.5 MB).
import { GoogleGenAI } from "@google/genai";

// Listening models, tried in order. Chosen by test on 2026-11-15: the same
// ukulele tune, three runs each. gemini-4-argon heard it right every time and
// fastest; gemini-3.1-pro and gemini-3.8-flash each invented a different song
// (ragtime piano, reggae) in a third to half of runs. The "-latest" aliases are
// a safety net for when the numbered models are retired.
// Override with SOUNDMAP_MODEL="model-a,model-b".
const MODELS = (process.env.SOUNDMAP_MODEL || "gemini-4-argon,gemini-4-carbon,gemini-pro-latest,gemini-flash-latest")
  .split(",").map(s => s.trim()).filter(Boolean);
// Turning notes into JSON is easy work; use the fast model first.
const SHAPE_MODELS = [...new Set(["gemini-flash-latest", ...MODELS])];

const API = "https://generativelanguage.googleapis.com";
const MAX_SONG_SECONDS = 15 * 60;
const MAX_UPLOAD = 200 * 1024 * 1024;
const CLIP_BEFORE = 6, CLIP_AFTER = 6;      // seconds around a moment that Gemini hears

let client;
function ai() {
  if (!process.env.GEMINI_API_KEY) throw new UserError("The server is missing its GEMINI_API_KEY.", 500);
  // The "-latest" aliases and JSON-schema output live on v1beta, not v1.
  return client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ytUrl = id => `https://www.youtube.com/watch?v=${id}`;

// ─── YouTube lookup (metadata only) ──────────────────────────────────────────
const YT_ID = /^[\w-]{11}$/;
const YT_CONTEXT = { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" } };

async function innertube(endpoint, body) {
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: YT_CONTEXT, ...body }),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new UserError("YouTube didn't answer. Try again, or paste the song's YouTube link instead.", 502);
  return resp.json();
}

function idFromUrl(text) {
  try {
    const u = new URL(text.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    const id = host === "youtu.be" ? u.pathname.slice(1)
      : host === "youtube.com" ? (u.searchParams.get("v") || u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1])
      : null;
    return id && YT_ID.test(id) ? id : null;
  } catch { return null; }
}

const seconds = text => (text || "").split(":").reduce((total, part) => total * 60 + (+part || 0), 0);
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

async function searchSongs(query) {
  const data = await innertube("search", { query });
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object" || found.length >= 20) return;
    if (node.videoRenderer) found.push(node.videoRenderer);
    else for (const key in node) walk(node[key]);
  })(data);
  return found
    .map(v => ({
      id: v.videoId,
      title: v.title?.runs?.map(r => r.text).join("") || "Untitled",
      channel: v.ownerText?.runs?.[0]?.text || "",
      duration: seconds(v.lengthText?.simpleText),
      thumb: thumb(v.videoId),
    }))
    .filter(v => YT_ID.test(v.id || "") && v.duration > 0 && v.duration <= MAX_SONG_SECONDS)
    .slice(0, 6);
}

async function describeVideo(id) {
  // oEmbed is YouTube's public metadata endpoint; it has no duration, so the
  // length is filled in from a search for the id when that finds the video.
  const resp = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ytUrl(id))}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new UserError("That YouTube link can't be opened. It may be private or removed.", 404);
  const meta = await resp.json();
  const match = (await searchSongs(id).catch(() => [])).find(v => v.id === id);
  return { id, title: meta.title, channel: meta.author_name || "", duration: match?.duration || 0, thumb: thumb(id) };
}

// GET /api/search?q=  → up to six songs, or the one video if q is a YouTube link
async function search(req) {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 200);
  if (q.length < 2) throw new UserError("Type a song name or paste a YouTube link.");
  const id = idFromUrl(q);
  if (id) return json({ results: [await describeVideo(id)], direct: true });
  if (/^https?:\/\//i.test(q)) throw new UserError("Only YouTube links work here. For anything else, upload the file.");
  return json({ results: await searchSongs(q) });
}

// ─── Uploads: browser → Gemini, we only open the door ────────────────────────
// POST /api/upload {mimeType, size}  → {uploadUrl}. The URL is single-use and
// carries no API key.
async function upload(req) {
  const { mimeType, size } = await req.json();
  if (!/^audio\/[\w.+-]+$/.test(mimeType || "")) throw new UserError("That doesn't look like audio.", 415);
  if (!(size > 0 && size <= MAX_UPLOAD)) throw new UserError(`Audio must be under ${MAX_UPLOAD / 1048576} MB.`, 413);
  ai();
  const resp = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
      // Google only lets a browser use the upload address if the session was
      // opened in the name of that browser's origin.
      ...(req.headers.get("origin") ? { Origin: req.headers.get("origin") } : {}),
    },
    body: JSON.stringify({ file: { display_name: "soundmap-upload" } }),
  });
  const uploadUrl = resp.headers.get("x-goog-upload-url");
  if (!resp.ok || !uploadUrl) throw new UserError("Gemini wouldn't open an upload. Try again in a moment.", 502);
  return json({ uploadUrl });
}

// ─── Turning a source into something Gemini can hear ─────────────────────────
// source: {kind:"youtube", id} | {kind:"file", name:"files/abc", mimeType}
async function audioPart(source, { from, to } = {}) {
  if (source?.kind === "youtube" && YT_ID.test(source.id || "")) {
    const windowed = from != null ? { startOffset: `${Math.floor(from)}s`, endOffset: `${Math.ceil(to)}s` } : { fps: 0.1 };
    return { fileData: { fileUri: ytUrl(source.id), mimeType: "video/*" }, videoMetadata: windowed };
  }
  if (source?.kind === "file" && /^files\/[\w-]+$/.test(source.name || "")) {
    let file = await ai().files.get({ name: source.name }).catch(() => null);
    for (let i = 0; file?.state === "PROCESSING" && i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      file = await ai().files.get({ name: source.name });
    }
    if (!file || file.state !== "ACTIVE") throw new UserError("That upload has expired. Load the sound again.", 410);
    return { fileData: { fileUri: file.uri, mimeType: file.mimeType } };
  }
  throw new UserError("No sound to analyse.");
}

// ─── Gemini ──────────────────────────────────────────────────────────────────
const isModelMissing = err =>
  err?.status === 404 || /not found|is not supported|no longer available|deprecated/i.test(err?.message || "");

async function withModels(models, call) {
  let lastErr;
  for (const model of models) {
    try { return await call(model); }
    catch (err) {
      lastErr = err;
      if (!isModelMissing(err)) throw err;
      console.warn(`[model] ${model} unavailable, trying next`);
    }
  }
  throw lastErr;
}

const said = response => {
  if (response.text) return response.text;
  const reason = response.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason || "empty response";
  throw new Error(`Gemini returned nothing (${reason}).`);
};

// No temperature override anywhere: current Gemini models stop listening and
// invent the analysis when it is lowered.
const hear = (parts) => withModels(MODELS, async model => {
  const response = await ai().models.generateContent({ model, contents: [{ role: "user", parts }] });
  return { model: response.modelVersion || model, text: said(response).trim() };
});

function listenPrompt({ measuredBpm, duration, video }) {
  const facts = [];
  if (video) facts.push("The source is a video. Judge by the audio only and ignore the picture, titles and any on-screen text. If it opens or closes with speech or non-musical footage, mark those stretches in STRUCTURE and describe only the music.");
  if (duration) facts.push(`It is ${duration.toFixed(0)} seconds long; structure timestamps must stay inside that.`);
  if (measuredBpm) facts.push(
    `A signal measurement (onset autocorrelation) of this file gives about ${measuredBpm} BPM. ` +
    `It can be off by a factor of two, but it is otherwise more trustworthy than tempo judged by ear. ` +
    `Reconcile your tempo with it and explain any half-time or double-time feel.`);

  return `You are SoundMap, a professional music producer and sonic analyst with deep expertise in all genres.
Listen to this audio carefully, start to finish, and describe exactly what you hear.

Be concrete and technical. Name instruments, patterns and techniques, not impressions.
If something can't be determined from the audio, say so instead of inventing it.
Do NOT name any artists, songs, albums or copyrighted works anywhere in your answer.

Write plain labelled notes covering every one of these:

HANDLE: a 2-5 word descriptive name for the sound
TEMPO: best single BPM, time signature, and the feel (half-time, double-time, swung, ahead/behind the beat, changes)
KEY: key and scale/mode, or "uncertain"
GENRE: primary genre and subgenre
GENRE LAYERS: every genre present, one per line as: genre | its role in the mix | what marks it
ERA: approximate era or production period
ENERGY: 1-10 and one short phrase
MOOD: 2-4 single words
DRUMS: programmed or live, kick and snare placement, hi-hat pattern, percussion layers, swing vs straight
BASS: style, sub/mid/melodic character, rhythmic role, instrument type
HARMONY: chord movement in Roman numerals if detectable, extensions, what makes the harmony distinctive
HOOK: main melodic element — register, instrument, character
TEXTURE: pads, strings, synths, background vocals, atmosphere
VOCALS: register, delivery, vibrato, phrasing, layering, processing — or "Instrumental"
MIX: vocal placement, stereo width, low end, high end, dry vs wet, density, compression feel
SIGNATURE: the production fingerprints that define this sound; analog or digital character
INSTRUMENTS: each instrument or element, one per line as: name | role | playing style | processing and effects
STRUCTURE: walk the whole piece in time order, one line per section as
  start_seconds - end_seconds | label | what changes here (under 15 words).
  Mark every drop, build, breakdown and silence — an editor cuts picture to these.
MASTER PROMPT: one paragraph of 150-250 words capturing the complete sonic DNA, written to paste
  into Suno, Udio or Lyria: tempo, key, instruments, drums, bass, vocal style, production character,
  mood, era. Describe the sound itself — what it IS, not who made it.
MEDIUM PROMPT: the same in about 100 words.
SHORT PROMPT: the essentials in about 50 words, for character-limited platforms.
MODIFIERS: three or four short prompt additions that push the sound in a direction, one per line as
  what it does (e.g. "Amplify the sub bass", "Push darker") | the text to add to the prompt
${facts.length ? "\nFacts about this source:\n- " + facts.join("\n- ") : ""}`;
}

// POST /api/listen {source, measuredBpm?, duration?} → {notes, model}
// Pass one of two. Asked to listen AND fill a JSON schema in a single call,
// Gemini sometimes stops listening and invents a plausible song. Free-text
// listening stays grounded; /api/shape then formats the notes with no audio.
async function listen(req) {
  const { source, measuredBpm, duration } = await req.json();
  const part = await audioPart(source);
  const started = Date.now();
  const { model, text } = await hear([part, { text: listenPrompt({
    measuredBpm: Number(measuredBpm) || null,
    duration: Number(duration) || null,
    video: source.kind === "youtube",
  }) }]);
  console.log(`[listen] ${source.kind} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${model}`);
  return json({ notes: text, model });
}

const str = description => ({ type: "string", description });
const list = (description, properties) => ({
  type: "array", description,
  items: { type: "object", properties, required: Object.keys(properties) },
});

const SCHEMA = {
  type: "object",
  properties: {
    handle: str("2-5 word descriptive name. Never an artist or song name."),
    tempo_bpm: { type: "number" },
    tempo_note: str("Time signature and feel, a few words."),
    key: str("Key and scale."),
    genre: str("Primary genre and subgenre."),
    genre_layers: list("Genre layers.", { genre: str(""), role: str(""), marks: str("") }),
    era: str(""),
    energy: { type: "integer", minimum: 1, maximum: 10 },
    energy_note: str(""),
    mood: { type: "array", items: { type: "string" } },
    drums: str(""), bass: str(""), harmony: str(""), hook: str(""), texture: str(""),
    vocals: str(""), mix: str(""), signature: str(""),
    instruments: list("Instrument palette.", { name: str(""), role: str(""), style: str(""), processing: str("") }),
    structure: list("Sections in time order.", {
      start_sec: { type: "number" }, end_sec: { type: "number" }, label: str(""), note: str(""),
    }),
    prompt_master: str("The MASTER PROMPT, verbatim."),
    prompt_medium: str("The MEDIUM PROMPT, verbatim."),
    prompt_short: str("The SHORT PROMPT, verbatim."),
    modifiers: list("Prompt modifiers.", { does: str("What it does."), add: str("Text to add to the prompt.") }),
  },
  required: ["handle", "tempo_bpm", "tempo_note", "key", "genre", "genre_layers", "era", "energy", "energy_note",
    "mood", "drums", "bass", "harmony", "hook", "texture", "vocals", "mix", "signature", "instruments",
    "structure", "prompt_master", "prompt_medium", "prompt_short", "modifiers"],
};

function tidy(data, duration) {
  const max = duration || Infinity;
  const rows = value => (Array.isArray(value) ? value : []);
  return {
    ...data,
    energy: Math.max(1, Math.min(10, Math.round(Number(data.energy) || 5))),
    mood: rows(data.mood).map(String).slice(0, 4),
    genre_layers: rows(data.genre_layers),
    instruments: rows(data.instruments),
    modifiers: rows(data.modifiers),
    structure: rows(data.structure)
      .map(s => ({
        start_sec: Math.max(0, Math.min(Number(s.start_sec) || 0, max)),
        end_sec: Math.max(0, Math.min(Number(s.end_sec) || 0, max)),
        label: String(s.label || "Section"),
        note: String(s.note || ""),
      }))
      .filter(s => s.end_sec > s.start_sec)
      .sort((a, b) => a.start_sec - b.start_sec),
  };
}

// POST /api/shape {notes, duration?} → the structured sheet
async function shape(req) {
  const { notes, duration } = await req.json();
  if (typeof notes !== "string" || notes.length < 50) throw new UserError("Nothing to format.");
  const data = await withModels(SHAPE_MODELS, async model => {
    const response = await ai().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text:
        "Below are a music producer's listening notes about one piece of audio. Convert them into the JSON " +
        "structure requested. Carry the content over faithfully and completely — do not add, embellish or " +
        "reinterpret anything, and do not introduce artist or song names.\n\nNOTES:\n" + notes.slice(0, 40000) }] }],
      config: { responseMimeType: "application/json", responseJsonSchema: SCHEMA },
    });
    return JSON.parse(said(response));
  });
  return json(tidy(data, Number(duration) || null));
}

// POST /api/ask {question, time?, source?, clip?, context?} → {answer}
//   · YouTube source + time  → Gemini hears just that window of the video
//   · clip (base64 WAV cut by the browser, with clipStart) → Gemini hears the clip
//   · no time                → Gemini hears the whole source
async function ask(req) {
  const body = await req.json();
  const question = String(body.question || "").trim().slice(0, 500);
  if (!question) throw new UserError("Ask a question first.");
  const time = body.time == null ? null : Math.max(0, Number(body.time) || 0);

  let part, where;
  if (time == null) {
    part = await audioPart(body.source);
    where = "The audio is the whole track. The question is about the track overall.";
  } else {
    let from, to;
    if (typeof body.clip === "string" && body.clip.length > 100) {
      if (body.clip.length > 4_000_000) throw new UserError("That clip is too large.", 413);
      from = Math.max(0, Number(body.clipStart) || 0);
      to = from + (Number(body.clipLength) || CLIP_BEFORE + CLIP_AFTER);
      part = { inlineData: { mimeType: "audio/wav", data: body.clip } };
      where = `The audio is an excerpt covering ${mmss(from)}–${mmss(to)} of the full track. The question is about the ` +
        `moment at ${mmss(time)}, which is ${(time - from).toFixed(1)} seconds into this excerpt.`;
    } else {
      from = Math.max(0, time - CLIP_BEFORE); to = time + CLIP_AFTER;
      part = await audioPart(body.source, { from, to });
      where = `You are given ${mmss(from)}–${mmss(to)} of the full track. The question is about the moment at ${mmss(time)}.`;
    }
    where += " Use what comes just before and after only as context.";
  }

  const c = body.context || {};
  const known = [
    c.genre && `Genre: ${String(c.genre).slice(0, 120)}`,
    c.tempo_bpm && `Tempo: ${Math.round(c.tempo_bpm)} BPM`,
    c.key && `Key: ${String(c.key).slice(0, 60)}`,
    Array.isArray(c.structure) && c.structure.length &&
      `Arrangement: ${c.structure.slice(0, 40).map(s => `${mmss(+s.start_sec || 0)} ${String(s.label).slice(0, 30)}`).join(", ")}`,
  ].filter(Boolean).join("\n");

  const { text } = await hear([part, { text:
`You are a professional music producer answering a question about a piece of audio. Listen closely first.
If the source is a video, judge by the audio only.

${where}
${known ? `\nWhat is already known about the full track:\n${known}\n` : ""}
Question: ${question}

Answer in 2-5 plain sentences, no markdown, no preamble. Be specific and technical: name the instrument
or sound source, how it is likely made or processed (synthesis type, effects, playing technique), and
what it is doing in the arrangement at that moment. When you refer to time, use the full track's
timestamps. If you genuinely can't tell, say what it could be and why you're unsure.` }]);
  console.log(`[ask] ${time == null ? "whole track" : mmss(time)} · ${question.slice(0, 80)}`);
  return json({ answer: text, time });
}

// ─── Router ──────────────────────────────────────────────────────────────────
const ROUTES = {
  "GET /api/search": search,
  "POST /api/upload": upload,
  "POST /api/listen": listen,
  "POST /api/shape": shape,
  "POST /api/ask": ask,
};

export async function handle(req) {
  const route = ROUTES[`${req.method} ${new URL(req.url).pathname.replace(/\/$/, "")}`];
  if (!route) return json({ error: "Not found." }, 404);
  try {
    return await route(req);
  } catch (err) {
    let status = err.status >= 400 && err.status < 600 ? err.status : 500;
    let message = err.message || "Something went wrong.";
    if (err instanceof SyntaxError) { status = 502; message = "Gemini sent back a malformed answer. Try again."; }
    else if (err.name === "TimeoutError") { status = 504; message = "That took too long. Try again."; }
    else if (!(err instanceof UserError)) {
      // Google errors often carry a JSON blob as the message; pull the readable part out.
      try { message = JSON.parse(message).error?.message || message; } catch {}
      if (status === 429) message = "Gemini's rate limit was reached. Wait a minute and try again.";
    }
    console.error(`[error] ${status} ${message}`);
    return json({ error: message }, status);
  }
}
