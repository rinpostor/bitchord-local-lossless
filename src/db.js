import { DatabaseSync } from 'node:sqlite'
import { paths, ensureDirs } from './config.js'

let db = null

export function getDb() {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(paths.database)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tracks (
      id           TEXT PRIMARY KEY,
      path         TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      artist       TEXT,
      album        TEXT,
      album_artist TEXT,
      genre        TEXT,
      duration     REAL,
      format       TEXT,
      codec        TEXT,
      bitrate      INTEGER,
      sample_rate  INTEGER,
      bit_depth    INTEGER,
      channels     INTEGER,
      lossless     INTEGER DEFAULT 0,
      size         INTEGER,
      mtime        INTEGER,
      has_artwork  INTEGER DEFAULT 0,
      artwork_key  TEXT,
      added_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
    CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title);
    CREATE INDEX IF NOT EXISTS idx_tracks_format ON tracks(format);
    CREATE INDEX IF NOT EXISTS idx_tracks_lossless ON tracks(lossless);
  `)
  return db
}

export function closeDb() {
  if (db) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    db = null
  }
}
