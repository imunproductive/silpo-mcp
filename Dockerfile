# Build stage: install all deps and compile TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# OAuth state and Silpo session are persisted here — mount a volume at /data
# so restarts/redeploys don't force users to re-authenticate.
ENV SILPO_MCP_STATE_FILE=/data/state.json \
    SILPO_MCP_SESSION_FILE=/data/session.json \
    SILPO_MCP_PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "dist/http.js"]
