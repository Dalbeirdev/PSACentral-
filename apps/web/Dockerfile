# PSA Control Center — Control Plane web image (Next.js standalone, Node 24).
# Build from the repository root:  docker build -f apps/web/Dockerfile -t psacc/control-plane-web:0.1.0 .
# The browser talks only to this origin; /api is proxied to the API service (API_INTERNAL_URL is
# compiled into the rewrite, so it is a build argument).

FROM node:24-alpine AS build
ARG API_INTERNAL_URL=http://api:4210
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone API_INTERNAL_URL=${API_INTERNAL_URL}
# Large tarballs (next, @next/swc) through the daemon's network: fewer parallel fetches, longer timeouts, more retries.
RUN pnpm config set network-concurrency 2 && pnpm config set fetch-retries 10 && pnpm config set fetch-timeout 900000 && pnpm config set fetch-retry-maxtimeout 120000
RUN pnpm install --frozen-lockfile --filter @psacc/web... \
 && pnpm --filter @psacc/contracts build \
 && pnpm --filter @psacc/web build
# The app ships no static public assets today; the runtime stage copies the directory regardless.
RUN mkdir -p /src/apps/web/public

FROM node:24-alpine
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="psacc-control-plane-web" \
      org.opencontainers.image.description="PSA Control Center — Control Plane web application" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="PSA Control Center"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/web/.next/standalone/ /app/
COPY --from=build --chown=node:node /src/apps/web/.next/static/ /app/apps/web/.next/static/
COPY --from=build --chown=node:node /src/apps/web/public/ /app/apps/web/public/
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1
CMD ["node", "apps/web/server.js"]
