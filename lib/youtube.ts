import ytdl from 'ytdl-core'
import * as fs from 'fs'

export interface YoutubeTrackInfo {
  title: string
  author: string
  duration: number
  videoId: string
}

export async function getYoutubeInfo(url: string): Promise<YoutubeTrackInfo> {
  const info = await ytdl.getInfo(url)
  const details = info.videoDetails
  return {
    title: details.title,
    author: details.author.name,
    duration: parseInt(details.lengthSeconds),
    videoId: details.videoId,
  }
}

export async function downloadYoutubeAudio(url: string, outPath: string): Promise<YoutubeTrackInfo> {
  const info = await ytdl.getInfo(url)
  const details = info.videoDetails

  await new Promise<void>((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, {
      quality: 'highestaudio',
      filter: 'audioonly',
    })
    
    const writeStream = fs.createWriteStream(outPath)
    stream.pipe(writeStream)
    
    stream.on('error', reject)
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
    
    // Timeout: 5 minutes max
    setTimeout(() => reject(new Error('YouTube download timeout')), 5 * 60 * 1000)
  })

  return {
    title: details.title,
    author: details.author.name,
    duration: parseInt(details.lengthSeconds),
    videoId: details.videoId,
  }
}

export function isValidYoutubeUrl(url: string): boolean {
  try {
    return ytdl.validateURL(url)
  } catch {
    return false
  }
}
