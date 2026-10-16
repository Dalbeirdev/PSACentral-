# PSA Control Center — Control Plane API image (NestJS, Node 24).
# Build from the repository root:  docker build -f apps/api/Dockerfile -t psacc/control-plane-api:0.1.0 .
# The same image runs migrations (`node dist/database/cli.js migrate`), the first-admin bootstrap and the API.

FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @psacc/api... \
 && pnpm --filter @psacc/contracts build \
 && pnpm --filter @psacc/api build \
 && pnpm --filter @psacc/api deploy --prod --legacy /out

FROM node:24-alpine
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="psacc-control-plane-api" \
      org.opencontainers.image.description="PSA Control Center — Control Plane API, agent gateway, migrations" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="PSA Control Center"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4210
WORKDIR /app
COPY --from=build --chown=node:node /out/ /app/
USER node
EXPOSE 4210 8443
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/v1/health/live" || exit 1
CMD ["node", "dist/main.js"]
