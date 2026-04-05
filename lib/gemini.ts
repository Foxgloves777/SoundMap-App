import { GoogleGenAI } from '@google/genai'
import * as fs from 'fs'
import * as path from 'path'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

const SOUNDMAP_SYSTEM_PROMPT = `You are SoundMap — a professional sonic architecture analyst. Your job is to deeply analyze any audio and extract its complete DNA for AI music generation.

You output ONLY structured markdown following this exact format. No preamble, no explanation, no apology — just the analysis.

---

# 🎵 SoundMap Analysis

## GENRE CLASSIFICATION

Identify every genre layer present. Use a markdown table:
| Genre Layer | Role in Mix | Characteristics |
|---|---|---|

## TEMPO & RHYTHM

- BPM: (detected or estimated range)
- Time Signature:
- Feel: (tight/loose, ahead/behind the beat, half-time, etc.)
- Rhythmic signature: (describe what makes the groove unique)
- Drum style: (programmed/live, kit description, pattern description)

## HARMONIC FOUNDATION

- Key: 
- Mode/Scale:
- Chord movement: (most common progressions, in Roman numerals)
- Extensions: (add9, maj7, sus4, etc. that appear)
- Harmonic signature: (what makes this music's harmony distinctive)

## VOCAL CHARACTERISTICS

- Register: (bass/baritone/tenor/alto/mezzo/soprano range)
- Delivery style: (breathy/chest/head voice, attack, articulation)
- Vibrato: (none/subtle/pronounced)
- Dynamic range: (whispers to belts, compressed or expressive)
- Phrasing: (ahead/behind beat, legato/staccato, breath pattern)
- Layering: (solo/harmonies/doubles, panning)
- Processing: (reverb type/size, delay, compression character)
- Signature technique: (any distinctive move that defines this vocalist)

(If no vocals present, write "No vocals — instrumental piece" and describe any lead instrument instead)

## INSTRUMENTATION PALETTE

For each instrument/element present:
### [Instrument Name]
- Type/Model:
- Role:
- Playing style:
- Processing/Effects:
- Frequency range:

## PRODUCTION CHARACTERISTICS

### Mix Signature
- Vocal placement:
- Stereo width:
- Low end:
- High end:
- Overall character:

### Production Era/Style
- Analog/Digital character:
- Key influences:
- Unique production fingerprints:

### Arrangement Philosophy
- Structure:
- Build pattern:
- Space and density:

---

## MASTER SOUNDMAP PROMPT

Write a single paragraph of 150-250 words that captures the COMPLETE sonic DNA. This is the master prompt — someone should be able to paste this into Suno, Udio, Lyria, or any AI music generator and get something in this style. Be specific about tempo, key, instruments, vocal style, production character, mood, and era. NO artist names. NO song titles. NO copyrighted references.

\`\`\`
[THE MASTER PROMPT HERE — plain text, no internal quotes, no line breaks]
\`\`\`

---

## MODIFIER BLOCKS

### To amplify [identify dominant element]:
\`\`\`
Add: [specific instructions]
\`\`\`

### To amplify [identify second element]:
\`\`\`
Add: [specific instructions]
\`\`\`

### To push toward more [mood/energy]:
\`\`\`
Add: [specific instructions]
\`\`\`

### Mood Overlays:
- **[Mood 1]:** "[specific prompt addition]"
- **[Mood 2]:** "[specific prompt addition]"
- **[Mood 3]:** "[specific prompt addition]"

---

## QUICK-USE PROMPTS

### Short (50 words — for character-limited platforms):
\`\`\`
[concise prompt hitting only the most essential elements]
\`\`\`

### Medium (100 words — balanced):
\`\`\`
[more detailed prompt with key production and mood elements]
\`\`\`

### Full: Use the MASTER SOUNDMAP PROMPT above.

---

*SoundMap output is copyright-safe — no artist names, song titles, or copyrighted references.*
*Use these prompts directly in Suno, Udio, Lyria, or any AI music generation platform.*`

export interface TrackInfo {
  title?: string
  author?: string
  duration?: number
  source: string
}

// Upload a file to Gemini Files API, return the file URI
async function uploadToGemini(filePath: string): Promise<{ uri: string; mimeType: string }> {
  const mimeType = getMimeType(filePath)
  
  const uploadedFile = await ai.files.upload({
    file: filePath,
    config: {
      mimeType,
      displayName: path.basename(filePath),
    }
  })

  let file = uploadedFile
  let attempts = 0
  while (file.state === 'PROCESSING' && attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    file = await ai.files.get({ name: file.name! })
    attempts++
  }

  if (file.state === 'FAILED') {
    throw new Error('Gemini file processing failed')
  }

  return { uri: file.uri!, mimeType: file.mimeType! }
}

// Stream analysis — yields chunks of markdown text
export async function* streamAnalysis(
  filePath: string,
  trackInfo: TrackInfo,
): AsyncGenerator<string> {
  // Upload to Gemini
  const { uri, mimeType } = await uploadToGemini(filePath)

  const sourceInfo = [
    trackInfo.title,
    trackInfo.author ? `by ${trackInfo.author}` : '',
    trackInfo.source !== 'Upload' ? `(${trackInfo.source})` : '',
  ].filter(Boolean).join(' ')

  try {
    const stream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: { mimeType, fileUri: uri }
            },
            {
              text: `Analyze this audio and produce a complete SoundMap following exactly the format in your instructions. Be thorough, specific, and technically precise. ${sourceInfo ? `Track: ${sourceInfo}` : ''}`
            }
          ]
        }
      ],
      config: {
        systemInstruction: SOUNDMAP_SYSTEM_PROMPT,
      },
    })

    for await (const chunk of stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
      if (text) yield text
    }
  } finally {
    // Cleanup uploaded file (non-critical)
    try {
      const fileMatch = uri.match(/files\/([^/]+)/)
      if (fileMatch) {
        await ai.files.delete({ name: `files/${fileMatch[1]}` })
      }
    } catch {}
  }
}

// Stream analysis from a text query (song name / description, no audio file)
export async function* streamTextAnalysis(query: string): AsyncGenerator<string> {
  const stream = await ai.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `The user is looking for a SoundMap analysis based on a text query. IMPORTANT RULES:

1. FIRST, identify the EXACT song they mean. If the artist or song name they provided is WRONG (e.g. wrong artist credited for a song), CORRECT it at the top of your response before the analysis. Add a brief note like: "**Note:** 'Hide and Seek' is by Imogen Heap, not Frou Frou (though Imogen Heap was one half of Frou Frou). Analyzing 'Hide and Seek' by Imogen Heap."

2. If the query is ambiguous (multiple songs with the same name, or could refer to different versions), state which specific track you are analyzing and why.

3. Analyze ONLY the specific song identified — do not blend or merge characteristics from different songs or artists.

4. Then produce a complete SoundMap following exactly the format in your instructions. Be thorough, specific, and technically precise. Use your knowledge of the track's production, instrumentation, and sonic character.

Query: ${query}`
          }
        ]
      }
    ],
    config: {
      systemInstruction: SOUNDMAP_SYSTEM_PROMPT,
    },
  })

  for await (const chunk of stream) {
    const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) yield text
  }
}

// Non-streaming version (for testing)
export async function analyzeAudioFile(filePath: string, sourceInfo?: string): Promise<string> {
  let markdown = ''
  const trackInfo: TrackInfo = { source: sourceInfo || 'Upload' }
  for await (const chunk of streamAnalysis(filePath, trackInfo)) {
    markdown += chunk
  }
  return markdown
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.mp3': 'audio/mp3',
    '.mp4': 'audio/mp4',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.aac': 'audio/aac',
    '.opus': 'audio/opus',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
  }
  return mimeMap[ext] || 'audio/mpeg'
}
