# Oct 21 2026 Node.js security release. The tag names the patched line;
# the index digest is what a rebuild actually pulls.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
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

# A2-228: the commit this image was built from, so /health can name it. Supplied by
# docker-compose.yml from deploy/deploy.sh; empty in any build that does not pass it, which
# /health reports as no build rather than as an old one.
ARG MC_BUILD_SHA=
ENV MC_BUILD_SHA=$MC_BUILD_SHA

# Install CLI tools for connectors (glibc required — hence node:22.23.4-slim, not alpine)
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli

# Install Cursor CLI + keyring for persistent auth (Cursor stores tokens in OS keyring).
# Pin the linux/x64 agent-cli package (version + sha256) instead of an unpinned
# install-script pipe into bash: that endpoint returned HTTP 500 on
# 2026-11-17 and failed publish-image (run 44168125203). Retry transient
# download errors; verify the checksum before extract.
ARG CURSOR_AGENT_VERSION=2026.11.13-eacade1
ARG CURSOR_AGENT_SHA256=c02e4321f20d691ee03af94d29948dc3a81c6c34e7328da7bb1afade4c75812f
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates dbus dbus-x11 gnome-keyring libsecret-1-0 python3 \
    && curl -fSL --retry 5 --retry-delay 2 --retry-all-errors \
         --connect-timeout 10 --max-time 180 \
         -o /tmp/cursor-agent.tar.gz \
         "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/x64/agent-cli-package.tar.gz" \
    && printf '%s  %s\n' "${CURSOR_AGENT_SHA256}" /tmp/cursor-agent.tar.gz \
         | sha256sum --check --strict \
    && mkdir -p "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}" \
    && tar -xzf /tmp/cursor-agent.tar.gz \
         -C "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}" \
         --strip-components=1 \
    && ln -sf "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}/cursor-agent" \
         /usr/local/bin/cursor-agent \
    && chmod -R a+rX /opt/cursor-agent \
    && rm -f /tmp/cursor-agent.tar.gz \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Run as non-root (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash connector \
    && mkdir -p /home/connector/.claude /home/connector/.cursor /home/connector/.gemini \
                /home/connector/.config/cursor /home/connector/.local/share/keyrings \
    && chown -R connector:connector /home/connector
COPY --from=build --chown=connector /app/dist ./dist
COPY --from=build --chown=connector /app/node_modules ./node_modules
COPY --from=build --chown=connector /app/package.json ./
COPY --from=build --chown=connector /app/prisma ./prisma
COPY --from=build --chown=connector /app/prisma.config.ts ./
# CONN-1666: Vault provider-key sourcing runs from the entrypoint at boot.
COPY --from=build --chown=connector /app/scripts ./scripts

# Disabled BENCH source component only; no broker scripts, credentials or Journal.
COPY deploy/bench-account-receiving.py deploy/bench-monetary-v2.disabled.json deploy/bench-receiving-package.py /app/deploy/
RUN python3 -B /app/deploy/bench-receiving-package.py seal \
    && chmod 0555 /app/deploy && chmod 0444 /app/deploy/*

COPY --chown=connector entrypoint.sh /usr/local/bin/entrypoint.sh

USER connector
EXPOSE 3900
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
