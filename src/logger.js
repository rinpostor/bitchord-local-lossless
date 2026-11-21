const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info
  const stamp = () => new Date().toISOString().slice(11, 19)

  const emit = (name, fn) => (...args) => {
    if (LEVELS[name] <= threshold) fn(`[${stamp()}] ${name.toUpperCase().padEnd(5)}`, ...args)
  }

  return {
    error: emit('error', console.error),
    warn: emit('warn', console.warn),
    info: emit('info', console.log),
    debug: emit('debug', console.log)
  }
}
