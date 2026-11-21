import crypto from 'node:crypto'
import { config, loadSecret } from './config.js'

let secret = null

function key() {
  if (!secret) secret = loadSecret()
  return secret
}

function sign(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url')
}

/**
 * Stable, expiring link for media BitChord fetches without auth headers.
 * `scope` separates stream / artwork / download so a link cannot be reused for another purpose.
 */
export function signedUrl(base, scope, id, extra = {}) {
  const exp = Math.floor(Date.now() / 1000) + config.mediaUrlTtlSeconds
  const query = new URLSearchParams({ ...extra, exp: String(exp) })
  const payload = `${scope}:${id}:${exp}`
  query.set('sig', sign(payload))
  return `${base}/${scope}/${encodeURIComponent(id)}?${query.toString()}`
}

export function verifySignature(scope, id, exp, sig) {
  if (!exp || !sig) return false
  const expiry = Number(exp)
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false
  const expected = sign(`${scope}:${id}:${expiry}`)
  const a = Buffer.from(String(sig))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Optional whole-addon gate for search/rescan when ACCESS_TOKEN is configured. */
export function tokenAllowed(req) {
  if (!config.accessToken) return true
  const header = req.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const provided = bearer || req.query.token || ''
  const a = Buffer.from(String(provided))
  const b = Buffer.from(config.accessToken)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
