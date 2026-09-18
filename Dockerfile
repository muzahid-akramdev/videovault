# VideoVault — Docker image for Render / Railway / Fly.io
# (This does NOT work on Vercel — Vercel can't run persistent binaries like
# yt-dlp/ffmpeg. Deploy this Dockerfile to Render, Railway, or Fly instead.)

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

COPY backend ./backend
COPY frontend ./frontend

WORKDIR /app/backend
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Refresh yt-dlp on boot so Facebook/Instagram extractor fixes land without a rebuild.
CMD ["sh", "-c", "pip3 install -q --break-system-packages -U yt-dlp || true; node server.js"]
