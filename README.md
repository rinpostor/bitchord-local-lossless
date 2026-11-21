# BitChord Local Lossless

Self-hosted lossless music server that plugs straight into [BitChord](https://bitchord.kushagrasingh.in) as an addon.
Your FLAC library stays on your own disk — BitChord just reads from it over HTTPS.

Tuned for **aptX Lossless** listening on a **UGREEN 40759** receiver + **Popcorn Bass X8 Pro**:
24-bit/96 kHz FLAC is delivered untouched, with an automatic 320k/128k MP3 fallback for low bandwidth.

---

## How it works

BitChord addons are plain HTTPS services with three routes:

| Route | Purpose |
|-------|---------|
| `GET /manifest.json` | Addon identity + capabilities |
| `GET /search?q=...` | Returns `{ tracks: [...] }` |
| `GET /stream/{id}` | Returns one playable rendition descriptor |

This server implements all three, plus signed media URLs, embedded artwork, Range requests and on-demand MP3 transcoding.

---

## Quick start (local)

```bash
git clone https://github.com/rinpostor/bitchord-local-lossless.git
cd bitchord-local-lossless
npm install

# point at your library
cp .env.example .env
echo "MUSIC_DIR=/home/YOU/Music" >> .env

npm start
```

Open <http://localhost:3000> — it shows the exact URL to paste into BitChord.

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`, no native build step) and **ffmpeg** for MP3 transcoding.

---

## Connecting BitChord

1. The addon must be reachable over **HTTPS** from your phone. `localhost` will not work.
   Expose it with a tunnel:

   ```bash
   # Cloudflare tunnel (free, no account needed for quick tunnels)
   cloudflared tunnel --url http://localhost:3000

   # or ngrok
   ngrok http 3000
   ```

   Copy the `https://…` URL it prints.

2. In BitChord: **Settings → Sources → Add an addon**.
3. Paste the tunnel URL (or `<url>/manifest.json`) and save.
4. Play a track. If the addon shows as *Outdated addon*, that only means it does not declare `bitchordAuth` — everything still works.

If you have a stable domain, set `PUBLIC_URL=https://music.example.com` so the generated links are always correct.
Without it, the URL is derived from the incoming request, which works behind any tunnel.

---

## Quality tiers

The manifest exposes a `quality` selector:

| Option | Behaviour |
|--------|-----------|
| **Lossless** | Streams the original file byte-for-byte (FLAC/WAV/ALAC/DSD) |
| **High** | Transcodes to MP3 320k on first play, then serves from cache |
| **Low** | Transcodes to MP3 128k |

Lossless mode is what you want on the UGREEN 40759 — the CSRA64215 in that receiver handles aptX and AAC, so the transcode tiers are only a bandwidth/fallback path.

---

## Configuration

All options live in `.env` (see `.env.example`):

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | |
| `PUBLIC_URL` | *(auto)* | Public HTTPS origin |
| `MUSIC_DIR` | `./music` | Library root, scanned recursively |
| `CACHE_DIR` | `./cache` | SQLite index, artwork, transcodes |
| `TRANSCODE_ENABLED` | `true` | Needs ffmpeg |
| `WATCH_ENABLED` | `true` | Rescan when files change |
| `ALLOW_DOWNLOADS` | `true` | Advertised to BitChord |
| `ACCESS_TOKEN` | *(empty)* | Require `?token=` on `/search` |
| `MEDIA_URL_TTL_SECONDS` | `1500` | Signed media link lifetime |

Supported formats: FLAC, WAV, AIFF, ALAC, APE, WavPack, DSD (dsf/dff), M4A, AAC, MP3, OGG, Opus, WMA.

---

## Other ways to run

**Docker**

```bash
docker compose up -d
```

**PM2 (keep it running on a desktop)**

```bash
npm i -g pm2
npm run pm2:start
npm run pm2:logs
```

**Render.com** — `render.yaml` is included; push the repo and use *New → Blueprint*.
Mount a persistent disk at `/music` and upload/copy your library there.

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with copy-ready URLs |
| `GET /health` | Library stats and feature flags |
| `POST /rescan` | Force a full re-index |
| `GET /media/{id}` | Signed audio (Range supported) |
| `GET /artwork/{id}` | Signed embedded cover art |

---

## License

GPL-3.0
