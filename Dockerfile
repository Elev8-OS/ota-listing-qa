# Schlankes Standard-Node-Image: es wird bewusst NIE die öffentliche
# Airbnb-/Booking.com-Seite serverseitig abgerufen (kein Playwright/Headless-
# Chromium mehr nötig) — jeglicher Datenimport läuft ausschliesslich über die
# Chrome-Extension im eingeloggten Browser der Person (siehe README.md).
FROM node:20-slim

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
