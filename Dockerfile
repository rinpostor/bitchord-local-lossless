FROM node:22-alpine

RUN apk add --no-cache ffmpeg
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /music /cache

ENV NODE_ENV=production \
    PORT=3000 \
    MUSIC_DIR=/music \
    CACHE_DIR=/cache

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "server.js"]
