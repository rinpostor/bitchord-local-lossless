import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config, paths } from './config.js'

const running = new Set()
const pending = []
const jobs = new Map()

function pump() {
  while (running.size < config.maxTranscode && pending.length) {
    const job = pending.shift()
    running.add(job.key)
    runJob(job)
  }
}

function finish(job) {
  running.delete(job.key)
  pump()
}

function runJob({ key, input, output, bitrate, resolve, reject }) {
  const tmp = `${output}.part`
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-vn', '-map', '0:a:0',
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    '-id3v2_version', '3',
    '-write_id3v1', '1',
    '-f', 'mp3',
    tmp
  ]

  const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    if (stderr.length > 4000) stderr = stderr.slice(-4000)
  })

  child.on('error', (err) => {
    finish({ key })
    reject(err)
  })

  child.on('close', (code) => {
    finish({ key })
    if (code === 0) {
      try {
        fs.renameSync(tmp, output)
        resolve(output)
      } catch (err) {
        reject(err)
      }
    } else {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() || 'unknown error'}`))
    }
  })
}

export function transcodeAvailable() {
  return config.transcodeEnabled
}

/**
 * Returns a cached MP3 path, transcoding on first request.
 * Concurrent requests for the same track share one job.
 */
export function transcode(track, quality, log) {
  const bitrate = quality === 'low' ? config.transcodeBitrateLow : config.transcodeBitrateHigh
  const key = `${track.id}-${bitrate}`
  const output = path.join(paths.transcoded, `${key}.mp3`)

  if (fs.existsSync(output) && fs.statSync(output).size > 0) return Promise.resolve(output)
  if (jobs.has(key)) return jobs.get(key).promise

  fs.mkdirSync(paths.transcoded, { recursive: true })
  log?.debug(`transcoding ${track.title} → ${bitrate}`)

  const promise = new Promise((resolve, reject) => {
    pending.push({ key, input: track.path, output, bitrate, resolve, reject, title: track.title })
    pump()
  }).finally(() => jobs.delete(key))

  jobs.set(key, { promise })
  return promise
}

/** Delete cached renditions for a track (used when the source disappears). */
export function purgeTranscodes(trackId) {
  try {
    for (const name of fs.readdirSync(paths.transcoded)) {
      if (name.startsWith(`${trackId}-`)) fs.rmSync(path.join(paths.transcoded, name), { force: true })
    }
  } catch {
    /* cache dir missing */
  }
}
