'use client'

import { useState, useEffect } from 'react'

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

interface Props {
  result: AnalysisResult
  onReset: () => void
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={copy}
      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
        copied
          ? 'bg-green-500/20 text-green-400 border border-green-500/30'
          : 'bg-white/10 text-white/60 hover:text-white border border-white/10 hover:border-white/30'
      }`}
    >
      {copied ? '✓ Copied!' : 'Copy'}
    </button>
  )
}

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={copy}
      className={`px-4 py-2 rounded-xl font-medium transition-all text-sm ${
        copied
          ? 'bg-green-500/20 text-green-400 border border-green-500/40'
          : 'bg-white/10 text-white border border-white/20 hover:bg-white/20'
      }`}
    >
      {copied ? '✓ Copied to clipboard' : '📋 Copy full analysis'}
    </button>
  )
}

// Extract code blocks from markdown for highlight display
function extractCodeBlocks(markdown: string): { label: string; content: string }[] {
  const blocks: { label: string; content: string }[] = []
  const lines = markdown.split('\n')
  let inBlock = false
  let currentContent: string[] = []
  let currentLabel = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    if (line.startsWith('```') && !inBlock) {
      inBlock = true
      currentContent = []
      // Look for label in preceding lines
      if (i > 0) {
        const prevLine = lines[i - 1].trim()
        if (prevLine && !prevLine.startsWith('#')) {
          currentLabel = prevLine
        }
      }
    } else if (line.startsWith('```') && inBlock) {
      inBlock = false
      const content = currentContent.join('\n').trim()
      if (content) {
        blocks.push({ label: currentLabel, content })
      }
      currentLabel = ''
    } else if (inBlock) {
      currentContent.push(line)
    }
  }

  return blocks
}

// Parse markdown into sections for rendering
function parseSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  let inSection = false
  let content: string[] = []
  const headingLevel = heading.match(/^#+/)?.[0].length || 2

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    if (line.startsWith(heading) || line === heading) {
      inSection = true
      continue
    }
    
    if (inSection) {
      // Stop at next same-level or higher heading
      const match = line.match(/^(#+) /)
      if (match && match[1].length <= headingLevel) {
        break
      }
      content.push(line)
    }
  }

  return content.join('\n').trim()
}

function MarkdownSection({ title, content }: { title: string; content: string }) {
  if (!content.trim()) return null
  
  const lines = content.split('\n')
  
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />
        
        // Headers
        if (line.startsWith('### ')) {
          return <h4 key={i} className="text-sm font-semibold text-white/80 mt-3 mb-1">{line.slice(4)}</h4>
        }
        if (line.startsWith('## ')) {
          return <h3 key={i} className="text-base font-semibold text-white mt-4 mb-2">{line.slice(3)}</h3>
        }
        
        // Table rows
        if (line.startsWith('|')) {
          return null // handled separately
        }
        
        // Bullet points
        if (line.startsWith('- **') || line.startsWith('- ')) {
          const text = line.slice(2)
          return (
            <div key={i} className="flex gap-2 text-sm text-white/70">
              <span className="text-white/30 mt-0.5">•</span>
              <span dangerouslySetInnerHTML={{ __html: text
                .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white/90">$1</strong>')
                .replace(/`(.+?)`/g, '<code class="bg-white/10 px-1 rounded text-xs font-mono">$1</code>')
              }} />
            </div>
          )
        }
        
        // Regular text
        return (
          <p key={i} className="text-sm text-white/70 leading-relaxed" dangerouslySetInnerHTML={{ __html: line
            .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white/90">$1</strong>')
            .replace(/`(.+?)`/g, '<code class="bg-white/10 px-1 rounded text-xs font-mono">$1</code>')
          }} />
        )
      })}
    </div>
  )
}

function TableSection({ content }: { content: string }) {
  const lines = content.split('\n').filter(l => l.startsWith('|'))
  if (lines.length < 2) return null
  
  const headers = lines[0].split('|').filter(Boolean).map(h => h.trim())
  const rows = lines.slice(2).map(row => row.split('|').filter(Boolean).map(c => c.trim()))
  
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/10">
            {headers.map((h, i) => (
              <th key={i} className="text-left text-white/50 font-medium py-2 pr-4 text-xs uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/5">
              {row.map((cell, j) => (
                <td key={j} className="py-2 pr-4 text-white/70 align-top">
                  <span dangerouslySetInnerHTML={{ __html: cell.replace(/\*\*(.+?)\*\*/g, '<strong class="text-white/90">$1</strong>') }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ResultsView({ result, onReset }: Props) {
  const { markdown, trackInfo } = result
  const codeBlocks = extractCodeBlocks(markdown)
  
  // Find the master prompt (biggest code block, or one after "MASTER SOUNDMAP PROMPT")
  const masterPrompt = codeBlocks.find(b => 
    b.label.toLowerCase().includes('master') || 
    b.content.length > 400
  ) || codeBlocks[0]
  
  // Quick-use prompts
  const shortPrompt = codeBlocks.find(b => b.label.toLowerCase().includes('short'))
  const mediumPrompt = codeBlocks.find(b => b.label.toLowerCase().includes('medium'))
  
  // Modifier blocks (all code blocks that aren't the quick-use or master)
  const modifierBlocks = codeBlocks.filter(b => 
    b !== masterPrompt && b !== shortPrompt && b !== mediumPrompt
  )

  // Extract sections
  const hasTable = markdown.includes('| Genre Layer |') || markdown.includes('| Genre |')

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="text-2xl">🎵</div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">SoundMap</h1>
            <p className="text-xs text-white/40">Sonic DNA extraction for AI music generation</p>
          </div>
        </div>
        <button
          onClick={onReset}
          className="text-sm text-white/50 hover:text-white border border-white/20 hover:border-white/40 px-4 py-2 rounded-lg transition-all"
        >
          ← Analyze another
        </button>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        
        {/* Track info */}
        <div className="flex items-start justify-between gap-4">
          <div>
            {trackInfo.title && (
              <h2 className="text-2xl font-bold">{trackInfo.title}</h2>
            )}
            {trackInfo.author && (
              <p className="text-white/50 mt-0.5">{trackInfo.author}</p>
            )}
            <p className="text-white/30 text-sm mt-1">
              Source: {trackInfo.source}
              {trackInfo.duration && ` · ${Math.floor(trackInfo.duration / 60)}:${String(trackInfo.duration % 60).padStart(2, '0')}`}
            </p>
          </div>
          <CopyAllButton text={markdown} />
        </div>

        {/* MASTER PROMPT — hero card */}
        {masterPrompt && (
          <div className="bg-gradient-to-br from-white/10 to-white/5 border border-white/20 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-lg">Master SoundMap Prompt</h3>
                <p className="text-white/40 text-sm">Copy this into Suno, Udio, or Lyria</p>
              </div>
              <CopyButton text={masterPrompt.content} />
            </div>
            <p className="text-white/80 text-sm leading-relaxed font-mono bg-white/5 rounded-xl p-4">
              {masterPrompt.content}
            </p>
          </div>
        )}

        {/* Quick-use prompts */}
        {(shortPrompt || mediumPrompt) && (
          <div className="space-y-3">
            <h3 className="font-bold text-base text-white/80">Quick-Use Prompts</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {shortPrompt && (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Short</span>
                    <CopyButton text={shortPrompt.content} />
                  </div>
                  <p className="text-white/70 text-xs leading-relaxed font-mono">{shortPrompt.content}</p>
                </div>
              )}
              {mediumPrompt && (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Medium</span>
                    <CopyButton text={mediumPrompt.content} />
                  </div>
                  <p className="text-white/70 text-xs leading-relaxed font-mono">{mediumPrompt.content}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Full markdown analysis */}
        <div className="space-y-6">
          <h3 className="font-bold text-base text-white/80 border-b border-white/10 pb-3">Full Sonic Analysis</h3>
          
          {/* Render the full markdown in a readable way */}
          <div className="space-y-6 text-sm">
            {markdown.split(/\n(?=## )/).map((section, i) => {
              const titleMatch = section.match(/^## (.+)/)
              if (!titleMatch) return null
              
              const title = titleMatch[1].trim()
              const body = section.slice(section.indexOf('\n') + 1).trim()
              
              // Skip headers we've already shown prominently
              if (title.toLowerCase().includes('master soundmap') || 
                  title.toLowerCase().includes('quick-use')) return null

              // Check if this section has a table
              const hasTableInSection = body.includes('|---|')
              
              return (
                <div key={i} className="bg-white/3 border border-white/8 rounded-xl p-5">
                  <h3 className="font-semibold text-white mb-4 text-base">{title}</h3>
                  
                  {hasTableInSection && (
                    <TableSection content={body} />
                  )}
                  
                  <MarkdownSection title={title} content={
                    hasTableInSection 
                      ? body.split('\n').filter(l => !l.startsWith('|')).join('\n')
                      : body
                  } />
                </div>
              )
            })}
          </div>
        </div>

        {/* Modifier blocks */}
        {modifierBlocks.length > 0 && (
          <div className="space-y-4">
            <h3 className="font-bold text-base text-white/80">Modifier Blocks</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {modifierBlocks.map((block, i) => (
                <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4">
                  {block.label && (
                    <div className="text-xs text-white/40 mb-2 font-medium">{block.label}</div>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-white/70 text-xs leading-relaxed font-mono flex-1">{block.content}</p>
                    <CopyButton text={block.content} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-white/20 text-xs py-4 border-t border-white/10">
          SoundMap output is copyright-safe — no artist names, song titles, or copyrighted references.
        </div>

      </div>
    </main>
  )
}
