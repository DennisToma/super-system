# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/provider-letta/package.json ./packages/provider-letta/package.json
RUN pnpm install --frozen-lockfile --filter @super-system/api... --filter @super-system/web...
COPY . .
RUN pnpm --filter @super-system/web build && pnpm --filter @super-system/api build
# Legacy deploy mode copies the selected production dependency closure without
# requiring injected workspace packages. Workspace source is bundled in the API.
RUN pnpm --filter @super-system/api deploy --prod --legacy /runtime

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV STATIC_DIR=/app/apps/web/dist
ENV APP_DATA_DIR=/app/.data
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./apps/api
COPY --from=build --chown=node:node /workspace/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3001/api/auth/session", {headers: {host: new URL(process.env.APP_ORIGIN).host}}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "apps/api/dist/index.js"]
