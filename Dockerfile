# syntax=docker/dockerfile:1

# Debian/glibc is intentional: node-canvas publishes and links against this
# ecosystem. Pin the Node major so local, CI and Fly do not drift silently.
FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libcairo2 \
      libfontconfig1 \
      libgif7 \
      libjpeg62-turbo \
      libpango-1.0-0 \
      librsvg2-2 \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "server.js"]
