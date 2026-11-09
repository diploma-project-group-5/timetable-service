# timetable-service: збірка TypeScript в окремому етапі, у фінальному образі — лише dist і прод-залежності.
FROM node:24-bookworm-slim AS build
# validator-lib і contracts — git-залежності (npm-реєстру в команди немає): потрібен git, а GitHub,
# який lock-файл записує як ssh, читаємо анонімно через https (репозиторії публічні).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# 3003 — API кабінету й публічні сторінки за QR (через шлюз).
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Міграції — окремою командою роллю timetable_owner: docker run ... node dist/migrate.js
CMD ["node", "dist/server.js"]
