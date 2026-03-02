FROM node:25-alpine AS builder

WORKDIR /app
COPY ../../package.json ../../package-lock.json ./
COPY packages/aave-core/package.json packages/aave-core/
COPY packages/server/package.json packages/server/

RUN npm ci --workspace=packages/aave-core --workspace=packages/server

COPY packages/aave-core/ packages/aave-core/
COPY packages/server/ packages/server/

RUN npm run build --workspace=packages/aave-core
RUN npm run build --workspace=packages/server

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/aave-core/package.json packages/aave-core/
COPY --from=builder /app/packages/aave-core/dist/ packages/aave-core/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/node_modules/ node_modules/

WORKDIR /app/packages/server
RUN mkdir -p data

EXPOSE 3001
CMD ["node", "dist/index.js"]
