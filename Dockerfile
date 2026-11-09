FROM node:22-bookworm-slim

WORKDIR /app

# curl — healthcheck; tesseract+poppler — local OCR for scans without text layer
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    tesseract-ocr \
    tesseract-ocr-rus \
    tesseract-ocr-eng \
    poppler-utils \
    fonts-noto-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && tesseract --version \
  && pdftoppm -v

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=43141
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
# 0: без реального источника таймер не плодит фиктивные закупки
ENV SYNC_INTERVAL_MS=0
ENV OCR_PROVIDER=auto
ENV OCR_LANGS=eng+rus
ENV MAIL_TRANSPORT=file
ENV OPENROUTER_ON_UPLOAD=0

RUN mkdir -p /app/data /app/data/uploads /app/data/mail-sink

EXPOSE 43141
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["npm", "run", "start"]
