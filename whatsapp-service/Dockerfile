FROM node:20-alpine

WORKDIR /app

# Dependencias do lockfile podem referenciar repositorios Git.
RUN apk add --no-cache git

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib

RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=8080
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["npm", "start"]
