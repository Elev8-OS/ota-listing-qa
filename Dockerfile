# Basis-Image von Microsoft: enthaelt Node.js + bereits vorinstallierten
# Chromium-Browser passend zur "playwright"-npm-Paketversion unten. Das
# vermeidet fragile "playwright install --with-deps"-Schritte im Build.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

# better-sqlite3 kompiliert bei Bedarf nativ nach; Build-Tools als Fallback,
# falls fuer diese Plattform/Node-Version kein vorgebautes Binary vorliegt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "server.js"]
