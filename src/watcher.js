import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const AUDIO_EXT = new Set([
  '.flac', '.wav', '.aif', '.aiff', '.alac', '.ape', '.wv', '.dsf', '.dff',
  '.m4a', '.mp4', '.aac', '.mp3', '.ogg', '.oga', '.opus', '.wma', '.mka'
])

const isAudio = (file) => AUDIO_EXT.has(path.extname(file).toLowerCase())

/**
 * Filesystem polling watcher (no native deps).
 * Snapshot is rebuilt on a debounce so copying an album in one go costs one scan.
 */
export function startWatcher({ onAdd, onRemove, log }) {
  const { musicDir, watchDebounceMs } = config
  let snapshot = new Map()

  try {
    fs.accessSync(musicDir)
  } catch {
    log?.warn(`watcher disabled, MUSIC_DIR missing: ${musicDir}`)
    return null
  }

  const walk = (dir) => {
    const found = new Map()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return found
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        for (const [k, v] of walk(full)) found.set(k, v)
      } else if (isAudio(full)) {
        try {
          found.set(full, fs.statSync(full).mtimeMs)
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
    return found
  }

  snapshot = walk(musicDir)

  let timer = null
  const queue = { added: [], removed: [] }

  const flush = async () => {
    timer = null
    const added = queue.added.splice(0)
    const removed = queue.removed.splice(0)
    for (const file of removed) await onRemove?.(file, log)
    for (const file of added) await onAdd?.(file, log)
    if (added.length || removed.length) {
      log?.info(`watcher: ${added.length} new, ${removed.length} removed`)
    }
  }

  const tick = () => {
    const current = walk(musicDir)
    for (const [file, mtime] of current) {
      if (snapshot.get(file) !== mtime) queue.added.push(file)
    }
    for (const file of snapshot.keys()) {
      if (!current.has(file)) queue.removed.push(file)
    }
    snapshot = current
    if (!queue.added.length && !queue.removed.length) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, watchDebounceMs)
  }

  const interval = setInterval(tick, Math.max(watchDebounceMs, 3000))
  interval.unref()

  log?.info(`watching ${musicDir} every ${Math.max(watchDebounceMs, 3000)}ms`)
  return { stop: () => clearInterval(interval) }
}
