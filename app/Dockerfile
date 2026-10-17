ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY config ./config
COPY scripts/check-release.mjs ./scripts/check-release.mjs
RUN mkdir -p /app/data && chown node:node /app/data

ARG APP_VERSION
ARG APP_BUILD_HASH
LABEL org.opencontainers.image.title="Visa Helper MCP App" \
      org.opencontainers.image.version="${APP_VERSION}" \
      io.visa-helper.build-hash="${APP_BUILD_HASH}"

USER node
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV VISA_HELPER_PRIVATE_CONTAINER=1
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/version').then(async r => { if (!r.ok || (await r.json()).service !== 'visa-helper') process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]
