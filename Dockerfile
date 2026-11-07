FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=43141
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV SYNC_INTERVAL_MS=300000

RUN mkdir -p /app/data /app/data/uploads

EXPOSE 43141
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["npm", "run", "start"]
