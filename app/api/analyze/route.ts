import { NextRequest } from 'next/server'
import * as fs from 'fs'
import * as path from 'path'
import { streamAnalysis, streamTextAnalysis, getMimeType, TrackInfo } from '@/lib/gemini'
import { downloadYoutubeAudio, getYoutubeInfo, isValidYoutubeUrl } from '@/lib/youtube'

export const maxDuration = 60

// NDJSON streaming response helper
function ndjsonStream(
  fn: (send: (obj: object) => void) => Promise<void>
): Response {
  const encoder = new TextEncoder()
  
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      }

      try {
        await fn(send)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Analysis failed'
        send({ type: 'error', error: message })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

function getExtension(mimeType: string, filename?: string): string {
  if (filename) {
    const ext = path.extname(filename)
    if (ext) return ext
  }
  const mimeToExt: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/aac': '.aac',
    'audio/opus': '.opus',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  }
  return mimeToExt[mimeType] || '.mp3'
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || ''

  // --- JSON body (YouTube URL or text query) ---
  if (contentType.includes('application/json')) {
    const { url, query } = await req.json()

    // --- TEXT QUERY (song name / description) ---
    if (query) {
      return ndjsonStream(async (send) => {
        send({ type: 'status', message: 'Analyzing from description...' })

        const trackInfo: TrackInfo = {
          title: query,
          source: 'Text',
        }

        send({ type: 'trackInfo', trackInfo })
        send({ type: 'status', message: 'Generating sonic blueprint...' })

        let markdown = ''
        for await (const chunk of streamTextAnalysis(query)) {
          markdown += chunk
          send({ type: 'chunk', text: chunk })
        }

        send({ type: 'done', markdown })
      })
    }

    if (!url) {
      return Response.json({ error: 'URL required' }, { status: 400 })
    }

    if (!isValidYoutubeUrl(url)) {
      return Response.json({ error: 'Invalid YouTube URL' }, { status: 400 })
    }

    return ndjsonStream(async (send) => {
      send({ type: 'status', message: 'Fetching track info...' })

      let ytInfo: Awaited<ReturnType<typeof getYoutubeInfo>>
      try {
        ytInfo = await getYoutubeInfo(url)
      } catch (e) {
        throw new Error('Could not load video. Check the URL or try a different track.')
      }

      if (ytInfo.duration > 10 * 60) {
        throw new Error('Track too long (max 10 minutes). Try a shorter track.')
      }

      send({ type: 'status', message: `Downloading "${ytInfo.title}"...` })

      const tmpPath = `/tmp/soundmap_yt_${Date.now()}.mp4`

      try {
        await downloadYoutubeAudio(url, tmpPath)

        send({ type: 'status', message: 'Uploading to Gemini...' })

        const trackInfo: TrackInfo = {
          title: ytInfo.title,
          author: ytInfo.author,
          duration: ytInfo.duration,
          source: 'YouTube',
        }

        send({ type: 'trackInfo', trackInfo })
        send({ type: 'status', message: 'Analyzing sonic architecture...' })

        let markdown = ''
        for await (const chunk of streamAnalysis(tmpPath, trackInfo)) {
          markdown += chunk
          send({ type: 'chunk', text: chunk })
        }

        send({ type: 'done', markdown })
      } finally {
        try { fs.unlinkSync(tmpPath) } catch {}
      }
    })
  }

  // --- FILE UPLOAD or RECORDING ---
  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData()
    const file = formData.get('audio') as File | null
    const source = formData.get('source') as string || 'upload'

    if (!file) {
      return Response.json({ error: 'No audio file provided' }, { status: 400 })
    }

    // 20MB limit (Netlify functions handle request body up to ~20MB with streaming)
    if (file.size > 20 * 1024 * 1024) {
      return Response.json({ error: 'File too large (max 20MB). Use YouTube URL for longer tracks.' }, { status: 400 })
    }

    return ndjsonStream(async (send) => {
      send({ type: 'status', message: 'Reading audio file...' })

      const buffer = Buffer.from(await file.arrayBuffer())
      const ext = getExtension(file.type, file.name)
      const tmpPath = `/tmp/soundmap_upload_${Date.now()}${ext}`

      try {
        fs.writeFileSync(tmpPath, buffer)

        send({ type: 'status', message: 'Uploading to Gemini...' })

        const trackInfo: TrackInfo = {
          title: source === 'recording' ? 'Live recording' : file.name.replace(/\.[^.]+$/, ''),
          source: source === 'recording' ? 'Recording' : 'Upload',
        }

        send({ type: 'trackInfo', trackInfo })
        send({ type: 'status', message: 'Analyzing sonic architecture...' })

        let markdown = ''
        for await (const chunk of streamAnalysis(tmpPath, trackInfo)) {
          markdown += chunk
          send({ type: 'chunk', text: chunk })
        }

        send({ type: 'done', markdown })
      } finally {
        try { fs.unlinkSync(tmpPath) } catch {}
      }
    })
  }

  return Response.json({ error: 'Unsupported request format' }, { status: 400 })
}
