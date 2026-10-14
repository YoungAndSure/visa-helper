FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV VISA_HELPER_PRIVATE_CONTAINER=1
CMD ["node", "src/server.js"]
