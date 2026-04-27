# syntax=docker/dockerfile:1.7
FROM tegojs/tego-node-pg:latest AS base

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY

RUN npm install -g corepack@latest
RUN corepack enable

WORKDIR /app

FROM base AS deps

RUN --mount=type=bind,source=.,target=/context,readonly \
    mkdir -p /app/apps /app/packages /app/plugins && \
    cp /context/package.json /app/package.json && \
    cp /context/pnpm-lock.yaml /app/pnpm-lock.yaml && \
    cp /context/pnpm-workspace.yaml /app/pnpm-workspace.yaml && \
    for dir in /context/apps/*; do \
      [ -d "$dir" ] || continue; \
      name=$(basename "$dir"); \
      mkdir -p "/app/apps/$name"; \
      cp "$dir/package.json" "/app/apps/$name/package.json"; \
    done && \
    for dir in /context/packages/*; do \
      [ -d "$dir" ] || continue; \
      name=$(basename "$dir"); \
      mkdir -p "/app/packages/$name"; \
      cp "$dir/package.json" "/app/packages/$name/package.json"; \
    done && \
    if [ -d /context/plugins ]; then \
      for dir in /context/plugins/*; do \
        [ -d "$dir" ] || continue; \
        [ -f "$dir/package.json" ] || continue; \
        name=$(basename "$dir"); \
        mkdir -p "/app/plugins/$name"; \
        cp "$dir/package.json" "/app/plugins/$name/package.json"; \
      done; \
    fi

RUN pnpm config set registry $NPM_REGISTRY
RUN --mount=type=cache,target=/pnpm/store pnpm install --shamefully-hoist

FROM deps AS builder

COPY . /app

RUN pnpm build:p

FROM base AS runner

ENV NODE_ENV=production

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/package.json /app/package.json
COPY --from=deps /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=builder /app/.version.json /app/.version.json
COPY --from=builder /app/apps/web/dist /app/apps/web/dist
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/docker/tego-nightly/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p /app/public /app/storage /app/plugins && \
    chmod +x /app/docker-entrypoint.sh && \
    find /app/packages -type d \( -name __tests__ -o -name __e2e__ -o -name coverage \) -prune -exec rm -rf {} + && \
    find /app/packages -type f \( -name '*.md' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete

ENTRYPOINT ["/app/docker-entrypoint.sh"]
