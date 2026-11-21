module.exports = {
  apps: [
    {
      name: 'bitchord-local-lossless',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        MUSIC_DIR: '/home/rafiabdan/bitchord-local-lossless/music',
        CACHE_DIR: '/home/rafiabdan/bitchord-local-lossless/cache'
        // PUBLIC_URL: 'https://your-tunnel.example.com',
      },
      watch: false,
      max_memory_restart: '400M',
      autorestart: true,
      out_file: './cache/pm2-out.log',
      error_file: './cache/pm2-err.log',
      time: true
    }
  ]
}
