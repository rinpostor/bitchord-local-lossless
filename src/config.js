import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const projectRoot = path.resolve(import.meta.dirname, '..')

export const config = {
  port: num(process.env.PORT, 3000),

  // Must be the public https origin the phone can reach.
  // Leave empty to auto-detect from request headers (works behind any tunnel).
  publicUrl: String(process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  musicDir: path.resolve(process.env.MUSIC_DIR || path.join(projectRoot, 'music')),
  cacheDir: path.resolve(process.env.CACHE_DIR || path.join(projectRoot, 'cache')),

  addonId: process.env.ADDON_ID || 'com.rinpostor.bitchord.local-lossless',
  addonName: process.env.ADDON_NAME || 'Local Lossless Library',
  addonVersion: process.env.ADDON_VERSION || '1.0.0',
  addonDescription:
    process.env.ADDON_DESCRIPTION ||
    'Your own FLAC library streamed straight to BitChord. No cloud, no quota.',

  allowDownloads: bool(process.env.ALLOW_DOWNLOADS, true),
  checkValidLossless: bool(process.env.CHECK_VALID_LOSSLESS, false),

  transcodeEnabled: bool(process.env.TRANSCODE_ENABLED, true),
  transcodeBitrateHigh: String(process.env.TRANSCODE_BITRATE_HIGH || '320k'),
  transcodeBitrateLow: String(process.env.TRANSCODE_BITRATE_LOW || '128k'),
  maxTranscode: num(process.env.MAX_TRANSCODE_CONCURRENT, 2),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 600),

  watchEnabled: bool(process.env.WATCH_ENABLED, true),
  watchDebounceMs: num(process.env.WATCH_DEBOUNCE_MS, 4000),

  // Optional shared secret. When set, search/rescan require ?token= or a Bearer header.
  accessToken: String(process.env.ACCESS_TOKEN || ''),

  // Signed media links (the player never sends headers when fetching audio).
  mediaUrlTtlSeconds: num(process.env.MEDIA_URL_TTL_SECONDS, 1500),

  logLevel: process.env.LOG_LEVEL || 'info'
}

export const paths = {
  root: projectRoot,
  cache: config.cacheDir,
  transcoded: path.join(config.cacheDir, 'transcoded'),
  artwork: path.join(config.cacheDir, 'artwork'),
  database: path.join(config.cacheDir, 'library.db'),
  secretFile: path.join(config.cacheDir, '.secret')
}

export function ensureDirs() {
  for (const dir of [config.cacheDir, paths.transcoded, paths.artwork]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * BitChord fetch links live ~15-30 minutes. We keep one stable signing key so
 * links survive a restart but cannot be forged.
 */
export function loadSecret() {
  ensureDirs()
  if (process.env.MEDIA_SECRET) return process.env.MEDIA_SECRET
  try {
    const existing = fs.readFileSync(paths.secretFile, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    /* first run */
  }
  const generated = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(paths.secretFile, generated, { mode: 0o600 })
  return generated
}
