import fs from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import mime from 'mime-types'
import rangeParser from 'range-parser'
import { buildManifest, toAddonTrack, toStreamDescriptor } from './src/addon.js'
import { tokenAllowed, verifySignature } from './src/auth.js'
import { config, ensureDirs, paths } from './src/config.js'
import { getDb } from './src/db.js'
import { createLogger } from './src/logger.js'
import { scanLibrary, scanOne, removeOne } from './src/scanner.js'
import { transcode } from './src/transcoder.js'
import { startWatcher } from './src/watcher.js'
const log = createLogger(config.logLevel)
const app = express()

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors())

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'http'
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host')
  return `${proto}://${host}`
}

const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false
})

// ---------------------------------------------------------------- manifest

app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json(buildManifest())
})

// ------------------------------------------------------------------ search

function searchTracks(query, limit = 100) {
  const db = getDb()
  const q = String(query || '').trim()

  if (!q) {
    return db
      .prepare('SELECT * FROM tracks ORDER BY added_at DESC, title ASC LIMIT ?')
      .all(limit)
  }

  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8)
  const clauses = terms.map(() =>
    "(title LIKE ? OR artist LIKE ? OR album LIKE ? OR album_artist LIKE ? OR genre LIKE ?)"
  )
  const like = terms.map((t) => `%${t.replace(/[%_]/g, (m) => `\\${m}`)}%`)
  const params = terms.flatMap((_, i) => [like[i], like[i], like[i], like[i], like[i]])

  const rows = db
    .prepare(
      `SELECT * FROM tracks
        WHERE ${clauses.join(' AND ')}
        ORDER BY lossless DESC, artist ASC, album ASC, title ASC
        LIMIT ?`
    )
    .all(...params, limit)

  return rows
}

app.get('/search', apiLimiter, (req, res) => {
  if (!tokenAllowed(req)) return res.status(401).json({ error: 'unauthorized' })
  const base = baseUrl(req)
  const rows = searchTracks(req.query.q)
  res.json({ tracks: rows.map((row) => toAddonTrack(row, base)) })
})

// ------------------------------------------------------------------ stream

function findTrack(id) {
  return getDb().prepare('SELECT * FROM tracks WHERE id = ?').get(id)
}

app.get('/stream/:id', apiLimiter, (req, res) => {
  const row = findTrack(req.params.id)
  if (!row) return res.status(404).json({ error: 'not found' })
  if (!fs.existsSync(row.path)) return res.status(404).json({ error: 'file missing' })

  const quality = ['lossless', 'high', 'low'].includes(req.query.quality)
    ? req.query.quality
    : 'lossless'

  res.set('Cache-Control', 'no-store')
  res.json(toStreamDescriptor(row, baseUrl(req), quality))
})

// ------------------------------------------------------------------- media

function streamFile(req, res, filePath, mimeHint, cacheable) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return res.status(404).json({ error: 'not found' })
  }

  const type = mimeHint || mime.lookup(filePath) || 'application/octet-stream'
  const range = req.headers.range && rangeParser(stat.size, req.headers.range)

  res.set({
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store'
  })

  if (range === -1) {
    res.status(416).set('Content-Range', `bytes */${stat.size}`).end()
    return
  }

  if (Array.isArray(range) && range.length) {
    const { start, end } = range[0]
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    })
    if (req.method === 'HEAD') return res.end()
    return fs.createReadStream(filePath, { start, end }).pipe(res)
  }

  res.set('Content-Length', stat.size)
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(filePath).pipe(res)
}

function guardMedia(scope) {
  return (req, res, next) => {
    const id = req.params.id
    const exp = req.query.exp
    const sig = req.query.sig
    if (!verifySignature(scope, id, exp, sig)) {
      return res.status(403).json({ error: 'link expired or invalid' })
    }
    next()
  }
}

app.get('/media/:id', guardMedia('media'), async (req, res) => {
  const row = findTrack(req.params.id)
  if (!row) return res.status(404).json({ error: 'not found' })

  const quality = req.query.q || 'lossless'

  if (quality === 'lossless' || !config.transcodeEnabled) {
    if (!fs.existsSync(row.path)) return res.status(404).json({ error: 'file missing' })
    return streamFile(req, res, row.path, mime.lookup(row.path), false)
  }

  try {
    const output = await transcode(row, quality, log)
    return streamFile(req, res, output, 'audio/mpeg', false)
  } catch (err) {
    log.warn(`transcode failed for ${row.title}: ${err.message}`)
    if (fs.existsSync(row.path)) return streamFile(req, res, row.path, mime.lookup(row.path), false)
    return res.status(500).json({ error: 'transcode failed' })
  }
})

app.get('/artwork/:id', guardMedia('artwork'), (req, res) => {
  const row = findTrack(req.params.id)
  if (!row?.artwork_key) return res.status(404).end()
  streamFile(req, res, path.join(paths.artwork, row.artwork_key), null, true)
})

// ------------------------------------------------------------------ health

app.get('/health', (req, res) => {
  const db = getDb()
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS tracks,
              SUM(lossless) AS lossless,
              SUM(has_artwork) AS artwork,
              COALESCE(SUM(size), 0) AS bytes
         FROM tracks`
    )
    .get()

  res.json({
    status: 'ok',
    addon: { id: config.addonId, name: config.addonName, version: config.addonVersion },
    library: {
      tracks: stats.tracks || 0,
      lossless: stats.lossless || 0,
      withArtwork: stats.artwork || 0,
      bytes: stats.bytes || 0,
      musicDir: config.musicDir
    },
    features: {
      transcoding: config.transcodeEnabled,
      downloads: config.allowDownloads,
      watcher: config.watchEnabled,
      tokenRequired: Boolean(config.accessToken)
    },
    publicUrl: config.publicUrl || null
  })
})

// ------------------------------------------------------------------ rescan

app.post('/rescan', apiLimiter, async (req, res) => {
  if (!tokenAllowed(req)) return res.status(401).json({ error: 'unauthorized' })
  const result = await scanLibrary({ force: Boolean(req.query.force), log })
  res.json({ ok: true, ...result })
})

// ----------------------------------------------------------------- gallery

app.get('/', (req, res) => {
  const base = baseUrl(req)
  const db = getDb()
  const stats = db.prepare('SELECT COUNT(*) AS n FROM tracks').get()
  res.type('html').send(landingPage(base, stats.n || 0))
})

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function landingPage(base, count) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.addonName)}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ef;
       font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{width:min(720px,92vw);padding:40px 0}
  h1{font-size:clamp(24px,4vw,34px);margin:0 0 6px;letter-spacing:-.02em}
  p.sub{color:#9aa3b2;margin:0 0 28px}
  .row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:14px 16px;
       border:1px solid #232838;border-radius:12px;margin-bottom:10px;background:#11141c}
  code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c8d1e0;word-break:break-all}
  .label{font-size:13px;color:#8d97a8;margin-bottom:2px}
  button{background:#1d2333;color:#e7e9ef;border:1px solid #2b3348;border-radius:8px;
         padding:7px 12px;cursor:pointer;font-size:13px;white-space:nowrap}
  button:active{transform:scale(.98)}
  .stat{display:flex;gap:24px;margin:26px 0 0;color:#9aa3b2;font-size:14px}
  .stat b{color:#e7e9ef;font-size:20px;display:block;font-weight:600}
</style></head>
<body><main>
  <h1>${escapeHtml(config.addonName)}</h1>
  <p class="sub">Paste one of these into BitChord &rarr; Settings &rarr; Sources &rarr; Add addon</p>

  <div class="row">
    <div><div class="label">Addon root (recommended)</div><code>${escapeHtml(base)}</code></div>
    <button onclick="navigator.clipboard.writeText('${escapeHtml(base)}')">Copy</button>
  </div>
  <div class="row">
    <div><div class="label">Manifest URL</div><code>${escapeHtml(base)}/manifest.json</code></div>
    <button onclick="navigator.clipboard.writeText('${escapeHtml(base)}/manifest.json')">Copy</button>
  </div>

  <div class="stat">
    <div><b>${count}</b>track in library</div>
    <div><b>${escapeHtml(config.transcodeEnabled ? 'ON' : 'OFF')}</b>MP3 fallback</div>
    <div><b>${escapeHtml(config.allowDownloads ? 'ON' : 'OFF')}</b>downloads</div>
  </div>
</main></body></html>`
}

// -------------------------------------------------------------------- boot

ensureDirs()

const server = app.listen(config.port, () => {
  log.info(`${config.addonName} listening on http://localhost:${config.port}`)
  log.info(`music dir: ${config.musicDir}`)
  log.info(`cache dir: ${config.cacheDir}`)
  if (config.publicUrl) log.info(`public url: ${config.publicUrl}`)

  scanLibrary({ log }).catch((err) => log.error(`initial scan failed: ${err.message}`))

  if (config.watchEnabled) startWatcher({ onAdd: scanOne, onRemove: removeOne, log })
})

function shutdown(signal) {
  log.info(`${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 4000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

export { app, server }
