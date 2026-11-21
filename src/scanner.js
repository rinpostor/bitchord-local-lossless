import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { config, paths } from './config.js'
import { getDb } from './db.js'

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.wav', '.aif', '.aiff', '.alac', '.ape', '.wv', '.dsf', '.dff',
  '.m4a', '.mp4', '.aac', '.mp3', '.ogg', '.oga', '.opus', '.wma', '.mka'
])

const LOSSLESS_EXTENSIONS = new Set([
  '.flac', '.wav', '.aif', '.aiff', '.alac', '.ape', '.wv', '.dsf', '.dff'
])

const LOSSLESS_CODECS = new Set([
  'flac', 'alac', 'ape', 'wavpack', 'wav', 'aiff', 'dsd', 'mlp', 'truehd',
  'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'
])

export function trackIdFor(filePath) {
  return crypto.createHash('sha1').update(path.relative(config.musicDir, filePath)).digest('hex').slice(0, 16)
}

function isLossless(ext, codec, format) {
  const c = String(codec || '').toLowerCase()
  if (LOSSLESS_CODECS.has(c)) return true
  const f = String(format || '').toLowerCase()
  if (f.includes('flac') || f.includes('alac') || f.includes('wav') || f.includes('aiff')) return true
  return LOSSLESS_EXTENSIONS.has(ext)
}

function fallbackTitle(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/^\d{1,3}[\s._-]+/, '').trim()
}

async function collectFiles(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectFiles(full)))
    else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}

async function writeArtwork(picture, trackId) {
  if (!picture?.data) return null
  const ext = picture.format?.includes('png') ? '.png' : '.jpg'
  const key = `${trackId}${ext}`
  await fs.writeFile(path.join(paths.artwork, key), Buffer.from(picture.data))
  return key
}

export async function readTags(filePath) {
  const stat = await fs.stat(filePath)
  const id = trackIdFor(filePath)
  const ext = path.extname(filePath).toLowerCase()

  let meta = null
  try {
    meta = await parseFile(filePath, { duration: true, skipCovers: false })
  } catch {
    /* unreadable tags: still index the file by filename */
  }

  const common = meta?.common ?? {}
  const format = meta?.format ?? {}
  const codec = format.codec || format.codecProfile || ext.replace('.', '')
  const lossless = isLossless(ext, codec, format.format)

  const cover = common.picture?.find((p) => p.type?.includes('Cover')) || common.picture?.[0]
  const artworkKey = cover ? await writeArtwork(cover, id) : null

  return {
    id,
    path: filePath,
    title: common.title?.trim() || fallbackTitle(filePath),
    artist: common.artist?.trim() || common.albumartist?.trim() || 'Unknown Artist',
    album: common.album?.trim() || 'Unknown Album',
    album_artist: common.albumartist?.trim() || null,
    genre: common.genre?.join(', ') || null,
    duration: Math.round(format.duration || 0),
    format: lossless ? 'flac' : (ext.replace('.', '') || 'mp3'),
    codec: String(codec || '').toLowerCase(),
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    sample_rate: format.sampleRate || null,
    bit_depth: format.bitsPerSample || null,
    channels: format.numberOfChannels || null,
    lossless: lossless ? 1 : 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    has_artwork: artworkKey ? 1 : 0,
    artwork_key: artworkKey,
    added_at: Math.floor(Date.now() / 1000)
  }
}

const UPSERT = `
  INSERT INTO tracks (
    id, path, title, artist, album, album_artist, genre, duration, format, codec,
    bitrate, sample_rate, bit_depth, channels, lossless, size, mtime,
    has_artwork, artwork_key, added_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT(path) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    album = excluded.album,
    album_artist = excluded.album_artist,
    genre = excluded.genre,
    duration = excluded.duration,
    format = excluded.format,
    codec = excluded.codec,
    bitrate = excluded.bitrate,
    sample_rate = excluded.sample_rate,
    bit_depth = excluded.bit_depth,
    channels = excluded.channels,
    lossless = excluded.lossless,
    size = excluded.size,
    mtime = excluded.mtime,
    has_artwork = excluded.has_artwork,
    artwork_key = excluded.artwork_key
`

function valuesFor(track) {
  return [
    track.id, track.path, track.title, track.artist, track.album, track.album_artist,
    track.genre, track.duration, track.format, track.codec, track.bitrate,
    track.sample_rate, track.bit_depth, track.channels, track.lossless,
    track.size, track.mtime, track.has_artwork, track.artwork_key, track.added_at
  ]
}

let scanning = null

export function scanLibrary({ force = false, log } = {}) {
  if (scanning) return scanning
  scanning = runScan({ force, log }).finally(() => {
    scanning = null
  })
  return scanning
}

async function runScan({ force, log }) {
  const started = Date.now()
  const db = getDb()

  try {
    await fs.access(config.musicDir)
  } catch {
    log?.warn(`MUSIC_DIR not found: ${config.musicDir}`)
    return { added: 0, removed: 0, total: 0, note: 'music directory missing' }
  }

  const files = await collectFiles(config.musicDir)
  const known = new Map()
  for (const row of db.prepare('SELECT path, mtime FROM tracks').all()) {
    known.set(row.path, row.mtime)
  }

  const upsert = db.prepare(UPSERT)
  let added = 0
  let updated = 0

  for (const file of files) {
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      continue
    }
    const mtime = Math.floor(stat.mtimeMs)
    if (!force && known.get(file) === mtime) continue

    try {
      const track = await readTags(file)
      upsert.run(...valuesFor(track))
      if (known.has(file)) updated += 1
      else added += 1
    } catch (err) {
      log?.warn(`skip ${path.basename(file)}: ${err.message}`)
    }
  }

  const present = new Set(files)
  const del = db.prepare('DELETE FROM tracks WHERE path = ?')
  let removed = 0
  for (const filePath of known.keys()) {
    if (!present.has(filePath)) {
      del.run(filePath)
      removed += 1
    }
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n
  const took = ((Date.now() - started) / 1000).toFixed(1)
  log?.info(`scan done in ${took}s — added ${added}, updated ${updated}, removed ${removed}, total ${total}`)
  return { added, updated, removed, total }
}

export async function scanOne(filePath, log) {
  const db = getDb()
  try {
    const track = await readTags(filePath)
    db.prepare(UPSERT).run(...valuesFor(track))
    log?.info(`indexed ${track.title}`)
  } catch (err) {
    log?.warn(`skip ${path.basename(filePath)}: ${err.message}`)
  }
}

export async function removeOne(filePath, log) {
  try {
    const db = getDb()
    const row = db.prepare('SELECT id FROM tracks WHERE path = ?').get(filePath)
    db.prepare('DELETE FROM tracks WHERE path = ?').run(filePath)
    if (row?.id) {
      for (const ext of ['.jpg', '.png']) {
        await fs.rm(path.join(paths.artwork, row.id + ext), { force: true })
      }
    }
    log?.info(`removed ${path.basename(filePath)} from index`)
  } catch (err) {
    log?.warn(`could not remove ${filePath}: ${err.message}`)
  }
}
