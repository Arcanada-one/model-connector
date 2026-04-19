FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace-config.json ./
COPY prisma ./prisma/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npx prisma generate && pnpm build

FROM base AS production
ENV NODE_ENV=production

# Install CLI tools for connectors (glibc required — hence node:22-slim, not alpine)
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli

# Install Cursor CLI (standalone agent binary for headless execution)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://cursor.com/install | bash \
    && cp -r /root/.local/share/cursor-agent /opt/cursor-agent \
    && ln -sf /opt/cursor-agent/versions/*/cursor-agent /usr/local/bin/cursor-agent \
    && chmod -R a+rX /opt/cursor-agent \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Run as non-root (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash connector \
    && mkdir -p /home/connector/.claude /home/connector/.cursor /home/connector/.config/gemini \
    && chown -R connector:connector /home/connector
COPY --from=build --chown=connector /app/dist ./dist
COPY --from=build --chown=connector /app/node_modules ./node_modules
COPY --from=build --chown=connector /app/package.json ./
COPY --from=build --chown=connector /app/prisma ./prisma
COPY --from=build --chown=connector /app/prisma.config.ts ./

USER connector
EXPOSE 3900
CMD ["node", "dist/src/main.js"]
