# Free Stars — образ для Koyeb / Railway / Fly.io и любого Docker-хостинга.
# Node 24 нужен для встроенного node:sqlite (22.5+ без флагов).
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/freestars.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY tools/owner-id.mjs ./tools/owner-id.mjs

RUN mkdir -p /app/data /app/logs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]