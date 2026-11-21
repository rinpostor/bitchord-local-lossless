import { closeDb } from '../src/db.js'
import { config } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { scanLibrary } from '../src/scanner.js'

const log = createLogger(config.logLevel)

log.info(`scanning ${config.musicDir}`)
const result = await scanLibrary({ force: true, log })
log.info(JSON.stringify(result))
closeDb()
