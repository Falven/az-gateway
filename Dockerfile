# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.10-alpine

FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /workspace/apps/az-gateway

FROM base AS deps
COPY apps/az-gateway/package.json ./package.json
COPY apps/az-gateway/pnpm-lock.yaml ./pnpm-lock.yaml
COPY apps/az-gateway/patches ./patches
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
  bun install --frozen-lockfile

FROM deps AS build
COPY apps/az-gateway/src ./src
COPY apps/az-gateway/plugins ./plugins
COPY apps/az-gateway/rollup.config.js ./rollup.config.js
COPY apps/az-gateway/tsconfig.json ./tsconfig.json
COPY apps/az-gateway/conf.json ./conf.json
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS runtime

ENV NODE_ENV=production
ENV PORT=8787

RUN addgroup -g 10001 -S app \
  && adduser -u 10001 -S -G app -h /home/app app

WORKDIR /app
COPY --from=build --chown=app:app /workspace/apps/az-gateway/build ./build
COPY --from=deps --chown=app:app /workspace/apps/az-gateway/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/apps/az-gateway/package.json ./package.json

USER app

EXPOSE 8787
STOPSIGNAL SIGTERM

ENTRYPOINT ["bun"]
CMD ["build/start-server.js"]
