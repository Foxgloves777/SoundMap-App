// SoundMap — client. No build step, no dependencies.

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

const INK = "#16140F", SIGNAL = "#E2401B", FAINT = "#CFC8B8", TICK = "#8C867A";
const BARS = 220;
const HISTORY_KEY = "soundmap.history.v2";
const HISTORY_MAX = 12;
const CLIP_BEFORE = 6, CLIP_AFTER = 6;
// Formats Gemini truly hears. Anything else (M4A, WebM…) is re-encoded to WAV
// in the browser first — given those, Gemini doesn't fail, it makes things up.
const GEMINI_NATIVE = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", aac: "audio/aac", aif: "audio/aiff", aiff: "audio/aiff" };

const sheet = $("sheet"), audio = $("audio"), canvas = $("canvas");

// source: null
//   | { kind: "file", blob, name, url, buffer?, remote? }      — buffer is the decoded AudioBuffer
//   | { kind: "youtube", id, title, channel, duration }
const state = {
  mode: "search",
  source: null,
  peaks: null, duration: 0, measuredBpm: null,
  result: null,                 // the entry on the sheet: { id, at, name, source, track?, peaks, data, asks }
  busy: false,
  askTime: 0, askWhole: false, asking: false,
  promptSize: "master",
};

// ─── Formatting ──────────────────────────────────────────────────────────────
const clock = s => {
  s = Math.max(0, s || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const size = b => b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const kindOf = label =>
  /drop|chorus|hook|climax|peak/i.test(label) ? "peak" :
  /silen|break|pause|rest|stop|speech|talk/i.test(label) ? "rest" : "body";
const words = text => (text || "").trim().split(/\s+/).filter(Boolean).length;

async function api(path, body) {
  let resp;
  try {
    resp = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new Error("Can't reach SoundMap. Check your connection and try again."); }
  const data = await resp.json().catch(() => ({ error: resp.status === 504 || resp.status === 502 ? "That took too long. Try again." : `Server error (${resp.status}).` }));
  if (!resp.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ─── Signal analysis (runs in the browser) ───────────────────────────────────
const Ctx = window.AudioContext || window.webkitAudioContext;
const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

async function decode(blob) {
  const ctx = new Ctx();
  try { return await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { ctx.close(); }
}

function mono(buffer, from, length) {
  const out = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[from + i];
  }
  return out;
}

function peaksOf(buffer, bars = BARS) {
  const data = mono(buffer, 0, buffer.length);
  const step = Math.max(1, Math.floor(data.length / bars));
  const peaks = [];
  let top = 0;
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    const end = Math.min(data.length, (b + 1) * step);
    for (let i = b * step; i < end; i += 4) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / ((end - b * step) / 4 || 1));
    peaks.push(rms);
    if (rms > top) top = rms;
  }
  return peaks.map(p => +(top ? p / top : 0).toFixed(3));
}

// Tempo by onset autocorrelation. Models guess tempo by ear and can miss by 20%;
// this reads it off the signal. It can still land on half or double time.
function measureBpm(buffer) {
  const sr = buffer.sampleRate;
  const span = Math.min(buffer.length, sr * 150);
  if (span < sr * 8) return null;                       // too short to trust
  const data = mono(buffer, Math.floor((buffer.length - span) / 2), span);

  const hop = Math.round(sr / 200), frames = Math.floor(span / hop);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sum += data[i] * data[i];
    rms[f] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) { onset[f] = Math.max(0, rms[f] - rms[f - 1]); mean += onset[f]; }
  mean /= frames;
  if (mean < 1e-6) return null;                          // silence
  for (let f = 0; f < frames; f++) onset[f] -= mean;

  const fps = sr / hop;
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxLag * 2 + 2);
  for (let lag = 1; lag < ac.length; lag++) {
    let sum = 0;
    for (let i = 0, n = frames - lag; i < n; i++) sum += onset[i] * onset[i + lag];
    ac[lag] = sum / (frames - lag);
  }
  let best = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (ac[lag] + 0.5 * ac[lag * 2]) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (bestScore <= 0) return null;
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
  return Math.round(60 * fps / (best + Math.max(-0.5, Math.min(0.5, shift))));
}

// Render part (or all) of a decoded buffer to a 16-bit WAV at a given rate.
async function toWav(buffer, { from = 0, length = buffer.duration - from, rate, channels }) {
  from = Math.max(0, Math.min(from, buffer.duration));
  length = Math.max(0.05, Math.min(length, buffer.duration - from));
  const ctx = new OfflineCtx(channels, Math.ceil(length * rate), rate);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.start(0, from, length);
  const out = await ctx.startRendering();

  const frames = out.length, bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, bytes, true);
  const data = Array.from({ length: channels }, (_, c) => out.getChannelData(c));
  for (let i = 0, at = 44; i < frames; i++) {
    for (let c = 0; c < channels; c++, at += 2) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

const base64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

// ─── Transport: one interface over the <audio> element and the YouTube player ─
const yt = { player: null, ready: false, api: null, blocked: false };

function loadYouTubeApi() {
  return yt.api ??= new Promise(resolve => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.append(el("script", { src: "https://www.youtube.com/iframe_api" }));
  });
}

async function mountPlayer(id) {
  unmountPlayer();
  const YT = await loadYouTubeApi();
  if (state.source?.kind !== "youtube" || state.source.id !== id) return;
  document.querySelector(".yt-frame").replaceChildren(el("div", { id: "yt-player" }));
  yt.player = new YT.Player("yt-player", {
    videoId: id,
    host: "https://www.youtube-nocookie.com",
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { yt.ready = true; refresh(); paint(); },
      onStateChange: e => {
        const playing = e.data === YT.PlayerState.PLAYING;
        setPlayIcon(playing);
        if (playing) loop(); else paint();
      },
      onError: () => {
        yt.blocked = true;
        refresh();
        if (!state.busy) setStatus("This upload can't be played here (its owner turned embedding off). It can still be mapped.");
      },
    },
  });
}

function unmountPlayer() {
  try { yt.player?.destroy(); } catch {}
  Object.assign(yt, { player: null, ready: false, blocked: false });
}

const onYt = () => state.source?.kind === "youtube";
const t = {
  can: () => onYt() ? yt.ready && !yt.blocked : state.source?.kind === "file",
  now: () => onYt() ? (yt.ready && yt.player.getCurrentTime?.()) || 0 : audio.currentTime || 0,
  total: () => state.duration || (onYt() ? (yt.ready && yt.player.getDuration?.()) || 0 : audio.duration || 0),
  paused: () => onYt() ? !(yt.ready && yt.player.getPlayerState?.() === 1) : audio.paused,
  play: () => onYt() ? yt.player.playVideo() : audio.play(),
  pause: () => onYt() ? yt.player.pauseVideo() : audio.pause(),
  seek: s => onYt() ? yt.player.seekTo(s, true) : (audio.currentTime = s),
};

// ─── Timeline strip ──────────────────────────────────────────────────────────
function draw(progress = 0) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const peaks = state.peaks;
  const loaded = !!state.source || !!state.result;
  const n = peaks ? peaks.length : 110;
  const gap = w / n, bar = Math.max(1, gap * 0.56), mid = h / 2;
  for (let i = 0; i < n; i++) {
    // No waveform (YouTube, or nothing loaded): draw a ruler instead.
    const len = peaks ? Math.max(2, peaks[i] * (h - 6)) : loaded ? (i % 10 === 0 ? 26 : i % 5 === 0 ? 14 : 6) : 2;
    g.fillStyle = !loaded ? FAINT : i / n < progress ? SIGNAL : peaks ? INK : TICK;
    g.fillRect(i * gap + (gap - bar) / 2, mid - len / 2, bar, len);
  }
}
new ResizeObserver(() => draw(progressNow())).observe(canvas);
const progressNow = () => (t.can() && t.total() ? Math.min(1, t.now() / t.total()) : 0);

const PLAY = "M7 4l14 8-14 8z", PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";
function setPlayIcon(playing) {
  $("play-icon").setAttribute("d", playing ? PAUSE : PLAY);
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

function paint() {
  const p = progressNow(), now = t.now();
  draw(p);
  $("clock").textContent = clock(now);
  $("playhead").hidden = !t.can() || (!now && t.paused());
  $("playhead").style.left = `${p * 100}%`;
  if (!$("ask-q").value && !state.asking && t.can()) { state.askTime = now; paintAsk(); }
  const playing = t.can() && !t.paused();
  document.querySelectorAll("[data-start]").forEach(n =>
    n.classList.toggle("is-now", playing && now >= +n.dataset.start && now < +n.dataset.end));
}
function loop() { paint(); if (t.can() && !t.paused()) requestAnimationFrame(loop); }

function seek(seconds, play = true) {
  state.askTime = seconds; state.askWhole = false; paintAsk();
  if (!t.can()) return;
  t.seek(seconds);
  if (play) t.play();
  paint();
}

$("play").addEventListener("click", () => t.can() && (t.paused() ? t.play() : t.pause()));
audio.addEventListener("play", () => { setPlayIcon(true); loop(); });
audio.addEventListener("pause", () => setPlayIcon(false));
audio.addEventListener("seeked", paint);
$("wave").addEventListener("click", e => {
  const total = t.total() || state.result?.data.duration;
  if (!total || sheet.dataset.state === "recording") return;
  const box = $("wave").getBoundingClientRect();
  seek((e.clientX - box.left) / box.width * total, t.can() && !t.paused());
});
window.addEventListener("keydown", e => {
  if (e.code === "Space" && t.can() && !/^(BUTTON|INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("play").click();
  }
});

// ─── Loading a sound ─────────────────────────────────────────────────────────
function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
function setStatus(msg) { $("status").textContent = msg; }
function setState(s) { sheet.dataset.state = s; }
function setMeta(rows) {
  $("spec-meta").replaceChildren(...rows.flatMap(([k, v]) => v ? [el("dt", { textContent: k }), el("dd", { textContent: v, title: v })] : []));
}

function clearReport() {
  state.result = null;
  $("report").hidden = true;
  $("lane").hidden = true;
  $("empty").hidden = false;
}

function dropSource() {
  audio.pause();
  if (state.source?.url) URL.revokeObjectURL(state.source.url);
  audio.removeAttribute("src");
  unmountPlayer();
  $("yt").hidden = true;
  sheet.classList.remove("has-yt");
  setPlayIcon(false);
  Object.assign(state, { source: null, peaks: null, duration: 0, measuredBpm: null });
}

function showLoaded(name, meta) {
  $("loaded-name").textContent = name;
  $("loaded-meta").textContent = meta;
  $("loaded").hidden = false;
  $("empty").hidden = true;
  $("spec-no").textContent = "Specimen — on the bench";
  $("spec-title").textContent = "Ready to map.";
  setState("ready");
}

async function setFile(blob, name) {
  showError("");
  clearReport();
  dropSource();
  const source = state.source = { kind: "file", blob, name, url: URL.createObjectURL(blob) };
  audio.src = source.url;
  showLoaded(name, size(blob.size));
  setMeta([["File", name], ["Size", size(blob.size)]]);
  setStatus("Reading the signal…");
  refresh();

  try {
    const buffer = await decode(blob);
    if (state.source !== source) return;                // replaced while decoding
    source.buffer = buffer;
    state.peaks = peaksOf(buffer);
    state.duration = buffer.duration;
    state.measuredBpm = measureBpm(buffer);
    $("loaded-meta").textContent = `${clock(buffer.duration)} · ${size(blob.size)}`;
    setMeta([["File", name], ["Length", clock(buffer.duration)], ["Size", size(blob.size)]]);
    setStatus(state.measuredBpm
      ? `Signal measure: ${state.measuredBpm} BPM · ready`
      : "Clip too short or too sparse to measure tempo · ready");
  } catch {
    setStatus("This browser can't decode the file for a waveform · ready to send anyway");
  }
  draw();
  refresh();
}

function setSong(song) {
  showError("");
  clearReport();
  dropSource();
  state.source = { kind: "youtube", ...song };
  state.duration = song.duration || 0;
  showLoaded(song.title, [song.duration && clock(song.duration), song.channel].filter(Boolean).join(" · "));
  showSong(song);
  setMeta([["Song", song.title], ["Length", song.duration ? clock(song.duration) : ""], ["Source", "YouTube"]]);
  setStatus("Found · ready. Tempo will be judged by ear; upload the file to have it measured.");
  draw();
  refresh();
}

function showSong(song) {
  $("yt").hidden = false;
  sheet.classList.add("has-yt");
  $("yt-title").textContent = song.title;
  $("yt-sub").replaceChildren(
    song.channel ? `${song.channel} · ` : "",
    el("a", { href: `https://www.youtube.com/watch?v=${song.id}`, target: "_blank", rel: "noopener", textContent: "Open on YouTube ↗" }));
  mountPlayer(song.id);
}

function clearSource() {
  dropSource();
  $("file").value = "";
  $("loaded").hidden = true;
  clearReport();
  $("spec-no").textContent = "Specimen — none loaded";
  $("spec-title").textContent = "Nothing on the bench yet.";
  setMeta([]);
  setState("empty");
  setStatus("");
  $("clock").textContent = "0:00";
  $("playhead").hidden = true;
  draw();
  refresh();
}

function refresh() {
  $("go").disabled = !["file", "youtube"].includes(state.source?.kind) || state.busy;
  $("go-label").textContent = state.busy ? "Mapping…" : state.result && state.source ? "Map it again" : "Map this sound";
  $("play").disabled = !t.can();
  paintAsk();
}

// ─── Modes ───────────────────────────────────────────────────────────────────
document.querySelectorAll(".mode").forEach(btn => btn.addEventListener("click", () => {
  if (rec.live) return;
  state.mode = btn.dataset.mode;
  document.querySelectorAll(".mode").forEach(b => {
    b.classList.toggle("is-on", b === btn);
    b.setAttribute("aria-selected", b === btn);
  });
  for (const m of ["search", "upload", "record"]) $(`panel-${m}`).hidden = state.mode !== m;
  if (state.mode === "search") $("q").focus();
}));

// ─── Find a song ─────────────────────────────────────────────────────────────
const findNote = msg => { $("find-note").textContent = msg; };

$("find").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q.length < 2) return;
  showError("");
  $("find-btn").disabled = true;
  findNote("Searching…");
  try {
    const { results, direct } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (direct) { $("results").replaceChildren(); findNote("Link loaded."); return setSong(results[0]); }
    findNote(results.length ? "Pick the right version. Official audio uploads read cleanest." : "Nothing found under 15 minutes. Try adding the artist.");
    $("results").replaceChildren(...results.map(r => {
      const btn = el("button", { type: "button" },
        el("img", { src: r.thumb, alt: "", loading: "lazy" }),
        el("div", {},
          el("div", { className: "r-title", textContent: r.title }),
          el("div", { className: "r-sub", textContent: `${clock(r.duration)} · ${r.channel}` })));
      btn.addEventListener("click", () => {
        setSong(r);
        if (matchMedia("(max-width: 860px)").matches) $("go").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return el("li", {}, btn);
    }));
  } catch (err) {
    findNote("");
    showError(err.message);
  } finally {
    $("find-btn").disabled = false;
  }
});

// ─── Upload ──────────────────────────────────────────────────────────────────
const drop = $("drop");
$("file").addEventListener("change", e => e.target.files[0] && setFile(e.target.files[0], e.target.files[0].name));
["dragenter", "dragover"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove("is-over"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) setFile(f, f.name); });
// Dropping anywhere else on the page shouldn't navigate away from the app.
["dragover", "drop"].forEach(type => window.addEventListener(type, e => e.preventDefault()));
$("clear").addEventListener("click", clearSource);

// ─── Recording ───────────────────────────────────────────────────────────────
const rec = { live: false, recorder: null, chunks: [], timer: null, raf: 0, ctx: null, started: 0 };

async function startRecording() {
  showError("");
  let stream;
  try {
    // Music, not speech: turn off the voice-call processing that mangles it.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    return showError("Microphone access was blocked. Allow it in the browser's site settings and try again.");
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
  rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = () => {
    stream.getTracks().forEach(track => track.stop());
    const type = rec.recorder.mimeType || mime || "audio/webm";
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(/[^\d]/g, "");
    setFile(new Blob(rec.chunks, { type }), `room-recording-${stamp}.${type.includes("mp4") ? "m4a" : "webm"}`);
  };
  rec.recorder.start(250);
  rec.live = true;
  rec.started = performance.now();

  // Live level trace on the sheet while recording.
  clearSource();
  setState("recording");
  $("empty").hidden = true;
  $("spec-title").textContent = "Listening to the room…";
  rec.ctx = new Ctx();
  const analyser = rec.ctx.createAnalyser();
  analyser.fftSize = 1024;
  rec.ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const live = [];
  let last = 0;
  const tick = now => {
    rec.raf = requestAnimationFrame(tick);
    if (now - last < 60) return;
    last = now;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    live.push(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    if (live.length > BARS) live.shift();
    state.peaks = live;
    state.source = { kind: "recording" };          // so the strip draws bars, not the empty ruler
    draw(1);
  };
  rec.raf = requestAnimationFrame(tick);

  $("rec-btn").classList.add("is-live");
  $("rec-btn").setAttribute("aria-label", "Stop recording");
  $("rec-status").textContent = "Recording — press to stop. 20–60 seconds is plenty.";
  rec.timer = setInterval(() => { $("rec-time").textContent = clock((performance.now() - rec.started) / 1000); }, 250);
}

function stopRecording() {
  rec.live = false;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ctx?.close();
  state.source = null;
  $("rec-btn").classList.remove("is-live");
  $("rec-btn").setAttribute("aria-label", "Start recording");
  $("rec-status").textContent = "Captured. Record again to replace it.";
  if (rec.recorder?.state !== "inactive") rec.recorder.stop();
}
$("rec-btn").addEventListener("click", () => rec.live ? stopRecording() : startRecording());

// ─── Map it ──────────────────────────────────────────────────────────────────
// Files go from this browser straight to Gemini's file store; SoundMap's server
// only hands out a single-use upload address.
async function sendFile(source) {
  if (source.remote) return source.remote;
  const ext = source.name.split(".").pop().toLowerCase();
  let blob = source.blob, mimeType = GEMINI_NATIVE[ext];
  if (!mimeType) {
    if (!source.buffer) throw new Error("This format can't be converted in your browser. Export it as MP3 or WAV and try again.");
    setStatus("Converting to a format Gemini hears…");
    blob = await toWav(source.buffer, { rate: 32000, channels: Math.min(2, source.buffer.numberOfChannels) });
    mimeType = "audio/wav";
  }
  setStatus(`Sending ${size(blob.size)} to Gemini…`);
  const { uploadUrl } = await api("/api/upload", { mimeType, size: blob.size });
  let resp;
  try {
    resp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
      body: blob,
    });
  } catch { throw new Error("The upload was interrupted. Check your connection and try again."); }
  const name = (await resp.json().catch(() => ({}))).file?.name;
  if (!resp.ok || !name) throw new Error("Gemini didn't accept the upload. Try again.");
  return source.remote = { kind: "file", name, mimeType };
}

// Mapping runs as a background job on the server (it outlasts a normal request),
// so start it, then check on it every couple of seconds.
async function runMap(body, onStatus) {
  const id = crypto.randomUUID();
  let started;
  try {
    started = await fetch("/.netlify/functions/map-background", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }),
    });
  } catch { throw new Error("Can't reach SoundMap. Check your connection and try again."); }
  if (!started.ok) throw new Error(`SoundMap couldn't start the job (${started.status}). Try again.`);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await api(`/api/job?id=${id}`);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Mapping failed. Try again.");
    onStatus(job.status);
  }
  throw new Error("Mapping is taking far longer than it should. Try again.");
}

async function analyse() {
  const source = state.source;
  if (!source || state.busy) return;
  showError("");
  state.busy = true;
  refresh();
  setState("working");
  $("spec-title").textContent = "Listening…";
  const t0 = performance.now();
  const secs = () => Math.round((performance.now() - t0) / 1000);
  let ticker;

  try {
    const remote = source.kind === "youtube" ? { kind: "youtube", id: source.id } : await sendFile(source);
    let phase = "Gemini is listening to the whole thing";
    ticker = setInterval(() => setStatus(`${phase} · ${secs()}s`), 500);
    const { data, model } = await runMap({ source: remote, measuredBpm: state.measuredBpm, duration: state.duration || null },
      status => { if (status === "writing") phase = "Writing up the sheet"; });

    const entry = {
      id: Date.now(), at: new Date().toISOString(),
      name: source.kind === "youtube" ? source.title : source.name,
      source: remote,
      track: source.kind === "youtube" ? { id: source.id, title: source.title, channel: source.channel, duration: source.duration } : null,
      peaks: state.peaks,
      data: { ...data, model, measured_bpm: state.measuredBpm, duration: state.duration || data.structure.at(-1)?.end_sec || 0 },
      asks: [],
    };
    if (state.source !== source) return;                 // they moved on while it ran
    saveHistory(entry);
    render(entry);
    setStatus(`Mapped in ${secs()}s`);
  } catch (err) {
    showError(err.message);
    $("spec-title").textContent = "Ready to map.";
    setState("ready");
    setStatus("");
  } finally {
    clearInterval(ticker);
    state.busy = false;
    refresh();
  }
}
$("go").addEventListener("click", analyse);

// ─── Render the sheet ────────────────────────────────────────────────────────
const TRAITS = [
  ["drums", "Drums & rhythm"], ["bass", "Bass"], ["harmony", "Harmony & chords"], ["hook", "Lead / hook"],
  ["texture", "Texture & layers"], ["vocals", "Vocals"], ["mix", "Mix character"], ["signature", "Production signature"],
];
const PROMPTS = { master: "prompt_master", medium: "prompt_medium", short: "prompt_short" };

function tempoCheck(d) {
  const m = d.measured_bpm, h = d.tempo_bpm;
  if (!m) return ["By ear only — upload the file to measure it", true];
  const near = (x, y) => Math.abs(x / y - 1) < 0.04;
  if (near(h, m)) return [`Matches signal measure (${m})`, false];
  if (near(h, m * 2) || near(h * 2, m)) return [`Signal measure ${m} — half/double-time reading`, false];
  return [`Signal measure says ${m} — verify by tapping`, true];
}

function paintPrompt() {
  const text = state.result?.data[PROMPTS[state.promptSize]] || "";
  $("prompt").textContent = text;
  $("prompt-count").textContent = `${words(text)} words · no artist names`;
  $("prompt-tabs").querySelectorAll("button").forEach(b => b.classList.toggle("is-on", b.dataset.size === state.promptSize));
}
$("prompt-tabs").addEventListener("click", e => {
  if (e.target.dataset.size) { state.promptSize = e.target.dataset.size; paintPrompt(); }
});

function render(entry) {
  const d = entry.data;
  state.result = entry;
  const total = d.duration || 0;

  setState("done");
  $("empty").hidden = true;
  $("spec-no").textContent = `Specimen № ${String(entry.id).slice(-6)}`;
  $("spec-title").textContent = d.handle || "Untitled sound";
  setMeta([
    [entry.track ? "Song" : "File", entry.name],
    ["Length", total ? clock(total) : ""],
    ["Read", new Date(entry.at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })],
    ["Model", d.model],
  ]);

  $("v-bpm").textContent = Math.round(d.tempo_bpm) || "—";
  $("v-tempo-note").textContent = d.tempo_note;
  const [check, off] = tempoCheck(d);
  $("v-tempo-check").textContent = check;
  $("v-tempo-check").classList.toggle("is-off", off);
  $("v-key").textContent = d.key;
  $("v-energy").textContent = d.energy;
  $("v-energy-note").textContent = d.energy_note;
  $("v-meter").replaceChildren(...Array.from({ length: 10 }, (_, i) => el("i", { className: i < d.energy ? "on" : "" })));
  $("v-genre").textContent = d.genre;
  $("v-era").textContent = d.era;
  $("v-moods").replaceChildren(...d.mood.map(m => el("li", { textContent: m })));

  state.promptSize = "master";
  paintPrompt();

  $("mods-block").hidden = !d.modifiers.length;
  $("mods").replaceChildren(...d.modifiers.map(m => {
    const btn = el("button", { className: "btn", textContent: "Copy" });
    btn.addEventListener("click", () => copy(btn, m.add));
    return el("li", {}, el("div", { className: "m-does", textContent: m.does }), btn, el("div", { className: "m-add", textContent: m.add }));
  }));

  // Arrangement lane + table
  const hasStructure = d.structure.length > 0 && total > 0;
  $("lane").hidden = !hasStructure;
  $("structure-block").hidden = !hasStructure;
  if (hasStructure) {
    const stamp = (node, s) => {
      Object.assign(node.dataset, { start: s.start_sec, end: s.end_sec, kind: kindOf(s.label) });
      node.addEventListener("click", () => seek(s.start_sec));
      return node;
    };
    $("lane").replaceChildren(...d.structure.map((s, i) => {
      const seg = stamp(el("button", { className: "seg", textContent: s.label, title: `${clock(s.start_sec)} ${s.label} — ${s.note}` }), s);
      seg.style.flex = `${s.end_sec - s.start_sec} 0 0`;
      seg.style.animationDelay = `${i * 50}ms`;
      return seg;
    }));
    $("structure").replaceChildren(...d.structure.map(s => stamp(el("tr", {},
      el("td", { className: "t", textContent: clock(s.start_sec) }),
      el("td", { className: "l", textContent: s.label }),
      el("td", { className: "n", textContent: s.note }),
      el("td", { className: "d", textContent: `${Math.round(s.end_sec - s.start_sec)}s` }),
    ), s)));
  }

  $("traits").replaceChildren(...TRAITS.filter(([k]) => d[k]).map(([k, label]) =>
    el("div", {}, el("dt", { textContent: label }), el("dd", { textContent: d[k] }))));

  $("palette-block").hidden = !d.instruments.length;
  $("palette-count").textContent = `${d.instruments.length} elements`;
  $("palette").replaceChildren(...d.instruments.map(i => el("div", {},
    el("dt", { textContent: i.name }),
    el("div", { className: "p-role", textContent: i.role }),
    el("dd", { textContent: [i.style, i.processing].filter(Boolean).join(" ") }))));

  $("layers-block").hidden = !d.genre_layers.length;
  $("layers").replaceChildren(...d.genre_layers.map(l => el("tr", {},
    el("td", { textContent: l.genre }), el("td", { textContent: l.role }), el("td", { textContent: l.marks }))));

  state.askWhole = false;
  state.askTime = t.can() ? t.now() : 0;
  paintAnswers();

  $("report").hidden = false;
  draw(progressNow());
  refresh();
  if (matchMedia("(max-width: 860px)").matches) sheet.scrollIntoView({ behavior: "smooth" });
}

// ─── Ask about a moment ──────────────────────────────────────────────────────
// YouTube sources can always be asked about (Gemini re-reads that window of the
// link). Files need the audio loaded here, because the browser cuts the excerpt.
const canAskMoment = () => {
  const entry = state.result;
  if (!entry) return false;
  return entry.source.kind === "youtube" || (state.source?.kind === "file" && !!state.source.buffer);
};

function paintAsk() {
  const live = canAskMoment() && !state.asking;
  $("ask-at").textContent = state.askWhole ? "Whole song" : `At ${clock(state.askTime)}`;
  $("ask-at").classList.toggle("is-whole", state.askWhole);
  for (const id of ["ask-q", "ask-go", "ask-at"]) $(id).disabled = !live;
  $("ask-chips").querySelectorAll("button").forEach(b => { b.disabled = !live; });
}

function askNote(msg, isError = false) {
  $("ask-note").textContent = msg;
  $("ask-note").hidden = !msg;
  $("ask-note").classList.toggle("is-error", isError);
}

function answerRow({ time, question, answer }, pending = false) {
  const when = time == null
    ? el("span", { className: "a-time", textContent: "Song" })
    : el("button", { type: "button", className: "a-time", textContent: clock(time), title: "Play from here" });
  if (time != null) when.addEventListener("click", () => seek(time));
  return el("li", { className: pending ? "is-pending" : "" },
    when,
    el("div", { className: "a-q", textContent: question }),
    el("div", { className: "a-a", textContent: pending ? "Listening to that moment…" : answer }));
}

function paintAnswers() {
  $("answers").replaceChildren(...(state.result?.asks || []).map(a => answerRow(a)));
  askNote(state.result && !canAskMoment() ? "Saved sheet. Load the file and map it again to ask new questions." : "");
  paintAsk();
}

async function ask(question) {
  const entry = state.result;
  question = question.trim();
  if (!question || !entry || state.asking || !canAskMoment()) return;
  const time = state.askWhole ? null : +state.askTime.toFixed(1);
  askNote("");
  state.asking = true;
  paintAsk();
  const pending = answerRow({ time, question }, true);
  $("answers").prepend(pending);
  try {
    const d = entry.data;
    const body = { question, time, source: entry.source, context: { genre: d.genre, tempo_bpm: d.tempo_bpm, key: d.key, structure: d.structure } };
    if (time != null && entry.source.kind === "file") {
      const from = Math.max(0, time - CLIP_BEFORE);
      const length = Math.min(time - from + CLIP_AFTER, state.source.buffer.duration - from);
      body.clip = await base64(await toWav(state.source.buffer, { from, length, rate: 24000, channels: 1 }));
      body.clipStart = from;
      body.clipLength = length;
    }
    const { answer } = await api("/api/ask", body);
    entry.asks = [{ time, question, answer }, ...(entry.asks || [])];
    updateHistory(entry);
    $("ask-q").value = "";
    if (state.result === entry) pending.replaceWith(answerRow(entry.asks[0]));
  } catch (err) {
    pending.remove();
    askNote(err.message, true);
  } finally {
    state.asking = false;
    paintAsk();
  }
}

$("ask-form").addEventListener("submit", e => { e.preventDefault(); ask($("ask-q").value || $("ask-q").placeholder); });
$("ask-at").addEventListener("click", () => { state.askWhole = !state.askWhole; paintAsk(); });
$("ask-chips").addEventListener("click", e => { if (e.target.tagName === "BUTTON") ask(e.target.textContent); });

// ─── Export ──────────────────────────────────────────────────────────────────
function markdown({ data: d, name, at, asks }) {
  const [check] = tempoCheck(d);
  const fence = text => ["```", text, "```", ""];
  return [
    `# SoundMap — ${d.handle}`,
    `_${name} · ${new Date(at).toLocaleString()} · ${d.model}_`,
    "",
    `- **Tempo:** ${Math.round(d.tempo_bpm)} BPM — ${d.tempo_note} (${check})`,
    `- **Key:** ${d.key}`,
    `- **Genre & era:** ${d.genre} · ${d.era}`,
    `- **Energy:** ${d.energy}/10 — ${d.energy_note}`,
    `- **Mood:** ${d.mood.join(", ")}`,
    "",
    "## Master prompt", ...fence(d.prompt_master),
    "## Medium prompt", ...fence(d.prompt_medium),
    "## Short prompt", ...fence(d.prompt_short),
    ...(d.modifiers.length ? ["## Modifiers", ...d.modifiers.map(m => `- **${m.does}:** ${m.add}`), ""] : []),
    "## Structure",
    ...d.structure.map(s => `- \`${clock(s.start_sec)}–${clock(s.end_sec)}\` **${s.label}** — ${s.note}`),
    "",
    "## Breakdown",
    ...TRAITS.filter(([k]) => d[k]).map(([k, label]) => `**${label}:** ${d[k]}\n`),
    ...(d.instruments.length ? ["## Instrument palette", ...d.instruments.map(i => `- **${i.name}** (${i.role}) — ${[i.style, i.processing].filter(Boolean).join(" ")}`), ""] : []),
    ...(d.genre_layers.length ? ["## Genre layers", "| Layer | Role | Characteristics |", "|---|---|---|", ...d.genre_layers.map(l => `| ${l.genre} | ${l.role} | ${l.marks} |`), ""] : []),
    ...(asks?.length ? ["## Questions", ...asks.map(a => `**${a.time == null ? "Whole song" : clock(a.time)} — ${a.question}**\n${a.answer}\n`)] : []),
  ].join("\n");
}

async function copy(btn, text) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
    btn.classList.add("is-done");
  } catch {
    btn.textContent = "Copy blocked";
  }
  setTimeout(() => { btn.textContent = label; btn.classList.remove("is-done"); }, 1600);
}
$("copy-prompt").addEventListener("click", e => copy(e.currentTarget, $("prompt").textContent));
$("copy-all").addEventListener("click", e => copy(e.currentTarget, markdown(state.result)));
$("download").addEventListener("click", () => {
  const slug = (state.result.data.handle || "sound").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const a = el("a", { href: URL.createObjectURL(new Blob([markdown(state.result)], { type: "text/markdown" })), download: `soundmap-${slug}.md` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ─── History (this browser only) ─────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(entry) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...loadHistory()].slice(0, HISTORY_MAX))); } catch {}
  paintHistory();
}
function updateHistory(entry) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().map(e => e.id === entry.id ? entry : e))); } catch {}
}
function paintHistory() {
  const items = loadHistory();
  $("history").hidden = !items.length;
  $("history-list").replaceChildren(...items.map(entry => {
    const btn = el("button", {},
      el("span", { className: "h-title", textContent: entry.track?.title || entry.data.handle || entry.name }),
      el("span", { className: "h-bpm", textContent: `${Math.round(entry.data.tempo_bpm)} BPM` }),
      el("span", { className: "h-sub", textContent: `${entry.data.key} · ${entry.data.genre}` }));
    btn.addEventListener("click", () => {
      if (state.result?.id === entry.id || state.busy) return;
      clearSource();
      if (entry.track) {
        // A saved song is fully live again: playable and askable.
        state.source = { kind: "youtube", ...entry.track };
        state.duration = entry.track.duration || entry.data.duration || 0;
        showLoaded(entry.track.title, [clock(state.duration), entry.track.channel].filter(Boolean).join(" · "));
        showSong(entry.track);
        render(entry);
        setStatus("Saved map");
      } else {
        // A saved file map carries the waveform but not the audio itself.
        state.peaks = entry.peaks;
        render(entry);
        setStatus("Saved map · load the file again to play it");
      }
    });
    return el("li", {}, btn);
  }));
}
$("history-clear").addEventListener("click", () => { localStorage.removeItem(HISTORY_KEY); paintHistory(); });

paintHistory();
draw();
refresh();
