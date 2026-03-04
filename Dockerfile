# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20.19.0-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /workspace
RUN corepack enable

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/az-gateway/package.json ./apps/az-gateway/package.json
COPY apps/az-gateway/patches ./apps/az-gateway/patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --filter ./apps/az-gateway... --frozen-lockfile
COPY apps/az-gateway/src ./apps/az-gateway/src
COPY apps/az-gateway/plugins ./apps/az-gateway/plugins
COPY apps/az-gateway/rollup.config.js ./apps/az-gateway/rollup.config.js
COPY apps/az-gateway/tsconfig.json ./apps/az-gateway/tsconfig.json
COPY apps/az-gateway/conf.json ./apps/az-gateway/conf.json
RUN pnpm --filter ./apps/az-gateway run build
RUN pnpm deploy --legacy --filter ./apps/az-gateway --prod /prod/az-gateway

FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=8787

RUN groupadd --gid 10001 app \
  && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=build --chown=app:app /workspace/apps/az-gateway/build ./build
COPY --from=build --chown=app:app /prod/az-gateway/node_modules ./node_modules
COPY --from=build --chown=app:app /prod/az-gateway/package.json ./package.json

USER app

EXPOSE 8787
STOPSIGNAL SIGTERM

ENTRYPOINT ["pnpm"]
CMD ["run", "start:node"]
