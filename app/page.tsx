'use client'

import { useState, useRef, useCallback } from 'react'
import ResultsView from '@/components/ResultsView'

type InputMode = 'upload' | 'youtube' | 'record' | 'text'
type AnalysisState = 'idle' | 'loading' | 'done' | 'error'

interface TrackInfo {
  title?: string
  author?: string
  duration?: number
  source: string
}

interface AnalysisResult {
  markdown: string
  trackInfo: TrackInfo
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('upload')
  const [state, setState] = useState<AnalysisState>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string>('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [songQuery, setSongQuery] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [streamProgress, setStreamProgress] = useState(0) // 0-100

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = () => {
    setResult(null)
    setState('idle')
    setError('')
    setStatusMessage('')
    setStreamProgress(0)
  }

  // Read NDJSON streaming response
  const readNdjsonStream = async (
    response: Response,
    onStatus: (msg: string) => void,
    onTrackInfo: (info: TrackInfo) => void,
    onProgress: (pct: number) => void,
  ): Promise<{ markdown: string; trackInfo: TrackInfo }> => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let markdown = ''
    let trackInfo: TrackInfo = { source: 'unknown' }
    let chunkCount = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          switch (msg.type) {
            case 'status':
              onStatus(msg.message)
              break
            case 'trackInfo':
              trackInfo = msg.trackInfo
              onTrackInfo(msg.trackInfo)
              break
            case 'chunk':
              markdown += msg.text
              chunkCount++
              // Estimate progress: most analyses are 80-120 chunks
              onProgress(Math.min(95, Math.round((chunkCount / 100) * 100)))
              break
            case 'done':
              if (msg.markdown) markdown = msg.markdown
              onProgress(100)
              break
            case 'error':
              throw new Error(msg.error)
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue // Incomplete JSON line
          throw e
        }
      }
    }

    return { markdown, trackInfo }
  }

  const runAnalysis = async (formData: FormData | { url: string } | { query: string }) => {
    setState('loading')
    setError('')
    setStatusMessage('Starting...')
    setStreamProgress(0)

    let trackInfo: TrackInfo = { source: 'unknown' }

    try {
      let response: Response

      if ('url' in formData || 'query' in formData) {
        response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        })
      } else {
        response = await fetch('/api/analyze', {
          method: 'POST',
          body: formData,
        })
      }

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Analysis failed')
      }

      const { markdown, trackInfo: ti } = await readNdjsonStream(
        response,
        (msg) => setStatusMessage(msg),
        (info) => { trackInfo = info },
        (pct) => setStreamProgress(pct),
      )

      if (!markdown) throw new Error('No analysis returned. Try a different audio source.')

      setResult({ markdown, trackInfo })
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setState('error')
    }
  }

  const handleUploadSubmit = () => {
    if (!uploadFile) return
    const fd = new FormData()
    fd.append('audio', uploadFile)
    fd.append('source', 'upload')
    runAnalysis(fd)
  }

  const handleYoutubeSubmit = () => {
    if (!youtubeUrl.trim()) return
    runAnalysis({ url: youtubeUrl.trim() })
  }

  const handleTextSubmit = () => {
    if (!songQuery.trim()) return
    runAnalysis({ query: songQuery.trim() })
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) setUploadFile(file)
  }, [])

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recordingChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(recordingChunksRef.current, { type: 'audio/webm' })
        const file = new File([blob], `recording_${Date.now()}.webm`, { type: 'audio/webm' })
        const fd = new FormData()
        fd.append('audio', file)
        fd.append('source', 'recording')
        runAnalysis(fd)
      }

      recorder.start(100)
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingTime(0)

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(t => t + 1)
      }, 1000)
    } catch {
      setError('Microphone access denied. Allow mic access and try again.')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setStatusMessage('Recording stopped — preparing audio...')
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  if (state === 'done' && result) {
    return <ResultsView result={result} onReset={reset} />
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
        <div className="text-2xl">🎵</div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">SoundMap</h1>
          <p className="text-xs text-white/40">Sonic DNA extraction for AI music generation</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-2xl">

          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">Drop a track. Get the blueprint.</h2>
            <p className="text-white/50 text-base max-w-md mx-auto">
              SoundMap analyzes any audio and outputs production-ready prompts for Suno, Udio, Lyria — any AI music platform.
            </p>
          </div>

          {/* Input mode tabs */}
          <div className="flex gap-1 bg-white/5 p-1 rounded-xl mb-6">
            {([
              { id: 'upload' as InputMode, label: '📁 Upload file' },
              { id: 'youtube' as InputMode, label: '▶️ YouTube link' },
              { id: 'text' as InputMode, label: '🔍 Song name' },
              { id: 'record' as InputMode, label: '🎙️ Record live' },
            ]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setMode(tab.id)}
                disabled={state === 'loading'}
                className={`flex-1 py-2.5 px-3 rounded-lg text-sm font-medium transition-all ${
                  mode === tab.id
                    ? 'bg-white text-black'
                    : 'text-white/50 hover:text-white/80 disabled:opacity-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">

            {/* UPLOAD */}
            {mode === 'upload' && (
              <div className="space-y-4">
                <div
                  className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
                    uploadFile
                      ? 'border-green-500/50 bg-green-500/5'
                      : 'border-white/20 hover:border-white/40'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                >
                  {uploadFile ? (
                    <>
                      <div className="text-3xl mb-2">✅</div>
                      <div className="font-medium">{uploadFile.name}</div>
                      <div className="text-white/40 text-sm mt-1">
                        {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                      </div>
                      <button
                        className="mt-3 text-xs text-white/40 hover:text-white/60 underline"
                        onClick={(e) => { e.stopPropagation(); setUploadFile(null) }}
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="text-4xl mb-3">🎵</div>
                      <div className="font-medium">Drop your audio file here</div>
                      <div className="text-white/40 text-sm mt-1">or click to browse</div>
                      <div className="text-white/30 text-xs mt-3">MP3 · WAV · FLAC · M4A · OGG · AAC — up to 20MB</div>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="audio/*,.flac,.aiff,.aif"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                />
                <button
                  onClick={handleUploadSubmit}
                  disabled={!uploadFile || state === 'loading'}
                  className="w-full py-3.5 bg-white text-black font-semibold rounded-xl disabled:opacity-30 hover:bg-white/90 transition-all text-base"
                >
                  Analyze Track →
                </button>
              </div>
            )}

            {/* YOUTUBE */}
            {mode === 'youtube' && (
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-white/60 block mb-2">YouTube URL</label>
                  <input
                    type="url"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isRecording && handleYoutubeSubmit()}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:border-white/50 transition-all"
                  />
                  <p className="text-xs text-white/30 mt-2">
                    Paste any YouTube music link — tracks up to 10 minutes.
                  </p>
                </div>
                <button
                  onClick={handleYoutubeSubmit}
                  disabled={!youtubeUrl.trim() || state === 'loading'}
                  className="w-full py-3.5 bg-white text-black font-semibold rounded-xl disabled:opacity-30 hover:bg-white/90 transition-all text-base"
                >
                  Analyze Track →
                </button>
              </div>
            )}

            {/* TEXT / SONG NAME */}
            {mode === 'text' && (
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-white/60 block mb-2">Song or artist</label>
                  <input
                    type="text"
                    value={songQuery}
                    onChange={(e) => setSongQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleTextSubmit()}
                    placeholder="e.g. Billie Eilish - Ocean Eyes"
                    className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:border-white/50 transition-all"
                  />
                  <p className="text-xs text-white/30 mt-2">
                    Type a song name, artist, or describe a sound — Gemini will analyze it from memory.
                  </p>
                </div>
                <button
                  onClick={handleTextSubmit}
                  disabled={!songQuery.trim() || state === 'loading'}
                  className="w-full py-3.5 bg-white text-black font-semibold rounded-xl disabled:opacity-30 hover:bg-white/90 transition-all text-base"
                >
                  Analyze Track →
                </button>
              </div>
            )}

            {/* RECORD */}
            {mode === 'record' && (
              <div className="space-y-4 text-center">
                <div className="py-6">
                  {!isRecording ? (
                    <>
                      <div className="text-5xl mb-4">🎙️</div>
                      <p className="text-white/60 text-sm mb-6">
                        Record any audio — hum a melody, play an instrument,<br />
                        or hold your phone up to a speaker.
                      </p>
                      <button
                        onClick={startRecording}
                        className="px-8 py-4 bg-red-500 hover:bg-red-400 text-white font-semibold rounded-full transition-all text-base"
                      >
                        Start Recording
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="relative inline-block mb-4">
                        <div className="text-5xl">🔴</div>
                        <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full animate-ping" />
                        <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full" />
                      </div>
                      <div className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-2">Recording</div>
                      <div className="text-3xl font-mono font-bold mb-2">{formatTime(recordingTime)}</div>
                      <p className="text-white/40 text-sm mb-6">Listening... tap stop when you&apos;re done.</p>
                      <button
                        onClick={stopRecording}
                        className="px-8 py-4 bg-white text-black font-semibold rounded-full transition-all text-base hover:bg-white/90"
                      >
                        ⏹ Stop & Analyze
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Loading state with progress */}
          {state === 'loading' && (
            <div className="mt-6 space-y-3">
              <div className="flex items-center gap-3 px-5 py-3 bg-white/5 border border-white/10 rounded-xl">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0" />
                <span className="text-white/70 text-sm">{statusMessage || 'Analyzing...'}</span>
              </div>
              {/* Progress bar */}
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-white h-full rounded-full transition-all duration-500"
                  style={{ width: `${streamProgress}%` }}
                />
              </div>
              {streamProgress > 10 && (
                <p className="text-white/30 text-xs text-center">
                  Gemini is reading the sonic DNA... results stream in as they&apos;re ready
                </p>
              )}
            </div>
          )}

          {/* Error state */}
          {state === 'error' && (
            <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
              <p className="text-red-400 text-sm font-medium">⚠️ {error}</p>
              <button onClick={reset} className="mt-2 text-xs text-white/50 hover:text-white/80 underline">
                Try again
              </button>
            </div>
          )}

        </div>
      </div>

      <div className="border-t border-white/10 px-6 py-3 text-center text-white/20 text-xs">
        SoundMap • Powered by Gemini • Output is copyright-safe for Suno, Udio, Lyria, and all AI music platforms
      </div>
    </main>
  )
}
