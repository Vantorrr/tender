FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=43141
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV SYNC_INTERVAL_MS=300000

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 43141
CMD ["npm", "run", "start"]
