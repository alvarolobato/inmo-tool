# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Stage 2: Build the application
FROM node:20-alpine AS builder
WORKDIR /app
ARG APP_GIT_DESCRIBE=
ENV APP_GIT_DESCRIBE=${APP_GIT_DESCRIBE}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install Claude Code CLI (linux/amd64 + arm64 via npm — the macOS binary cannot
# be bind-mounted into a Linux container).
# Credentials are bind-mounted at runtime: ~/.claude/.credentials.json → /home/nextjs/.claude/
RUN npm install -g @anthropic-ai/claude-code --prefer-offline 2>/dev/null || \
    npm install -g @anthropic-ai/claude-code

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The config schema is NOT baked into the image. It is delivered at runtime by
# the docker-compose bind mount `./config/schema.yaml:/app/config/schema.yaml:ro`
# (see docker-compose.yml) with CONFIG_SCHEMA_PATH=/app/config/schema.yaml — the
# single canonical source is the repo-root config/schema.yaml, shared with the
# ETL service (whose Dockerfile likewise does not bake it). Keeping a baked copy
# here would require the build context at repo root and would drift from the
# mounted file; the mount always wins under compose, so we rely on it.
COPY --chown=nextjs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
# Wrapper sets keepAliveTimeout=65s before Next.js creates its HTTP server.
# The default Node.js 18+ value (5s) drops SSE connections mid-stream.
COPY --chown=nextjs:nodejs server-wrapper.js /app/server-wrapper.js

USER nextjs

EXPOSE 4000

ENV PORT=4000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server-wrapper.js"]
