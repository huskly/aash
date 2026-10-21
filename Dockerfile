FROM node:25-alpine AS builder
WORKDIR /app
RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg && npm install -g corepack && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/aave-core/package.json packages/aave-core/
COPY packages/server/package.json packages/server/
RUN yarn install --immutable
COPY . .
RUN yarn workspace @aave-monitor/core run build
# Vite inlines VITE_* env vars at build time.
# docker compose: passed via build args; hl: passed via --secret mounts.
ARG VITE_THE_GRAPH_API_KEY
ARG VITE_COINGECKO_API_KEY
RUN --mount=type=secret,id=VITE_THE_GRAPH_API_KEY \
    --mount=type=secret,id=VITE_COINGECKO_API_KEY \
    VITE_THE_GRAPH_API_KEY=${VITE_THE_GRAPH_API_KEY:-$(cat /run/secrets/VITE_THE_GRAPH_API_KEY 2>/dev/null)} \
    VITE_COINGECKO_API_KEY=${VITE_COINGECKO_API_KEY:-$(cat /run/secrets/VITE_COINGECKO_API_KEY 2>/dev/null)} \
    yarn build
RUN yarn workspace @aave-monitor/server run build

FROM node:25-alpine
# Node 25 has no release that drops the compromised eMudhra intermediates from its bundled
# roots, so verify against Alpine's CA store, upgraded at build time.
RUN apk add --no-cache --upgrade ca-certificates
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/package.json /app/yarn.lock ./
COPY --from=builder /app/packages/aave-core/package.json packages/aave-core/
COPY --from=builder /app/packages/aave-core/dist/ packages/aave-core/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ public/
WORKDIR /app/packages/server
RUN mkdir -p data
EXPOSE 3001
CMD ["node", "dist/index.js"]
