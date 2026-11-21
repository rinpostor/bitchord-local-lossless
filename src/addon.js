import { config } from './config.js'
import { signedUrl } from './auth.js'

/**
 * Manifest as described by the BitChord addon docs.
 * https://bitchord.kushagrasingh.in/docs
 */
export function buildManifest() {
  return {
    id: config.addonId,
    name: config.addonName,
    version: config.addonVersion,
    description: config.addonDescription,
    resources: ['search', 'stream'],
    // Official-app proof is only available to addons registered with BitChord,
    // so a self-hosted server advertises false and still works everywhere.
    bitchordAuth: false,
    allowDownloads: config.allowDownloads ? 1 : 0,
    checkValidLossless: config.checkValidLossless ? 1 : 0,
    settings: [
      {
        key: 'quality',
        type: 'select',
        default: 'lossless',
        options: [
          { label: 'Lossless (FLAC as-is)', value: 'lossless' },
          { label: 'High (MP3 320k)', value: 'high' },
          { label: 'Low (MP3 128k)', value: 'low' }
        ]
      }
    ]
  }
}

function audioQuality(row) {
  return row.lossless ? 'LOSSLESS' : 'LOSSY'
}

/** Map a DB row to the `tracks[]` shape BitChord expects. */
export function toAddonTrack(row, base) {
  const track = {
    id: row.id,
    title: row.title,
    artist: row.artist || 'Unknown Artist',
    album: row.album || 'Unknown Album',
    duration: Math.round(row.duration || 0),
    format: row.format || 'flac',
    audioQuality: audioQuality(row),
    bitrate: row.bitrate || undefined,
    sampleRate: row.sample_rate || undefined,
    bitDepth: row.bit_depth || undefined
  }
  if (row.has_artwork) {
    track.artworkURL = signedUrl(base, 'artwork', row.id)
  }
  return track
}

/** Stream descriptor for /stream/{id}. */
export function toStreamDescriptor(row, base, quality) {
  const useLossless = quality === 'lossless' || !config.transcodeEnabled

  if (useLossless) {
    return {
      url: signedUrl(base, 'media', row.id, { q: 'lossless' }),
      codec: row.codec || row.format || 'flac',
      container: row.format === 'flac' ? 'flac' : (row.format || 'flac'),
      manifest: 'none',
      encrypted: false,
      sampleRate: row.sample_rate || undefined,
      bitDepth: row.bit_depth || undefined,
      bitrate: row.bitrate || undefined
    }
  }

  return {
    url: signedUrl(base, 'media', row.id, { q: quality }),
    codec: 'mp3',
    container: 'mp3',
    manifest: 'none',
    encrypted: false,
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: quality === 'low' ? 128 : 320
  }
}
