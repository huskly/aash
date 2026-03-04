FROM node:25-alpine AS build
WORKDIR /app

ARG VITE_NOTIFICATION_API_URL=http://localhost:3001
ENV VITE_NOTIFICATION_API_URL=${VITE_NOTIFICATION_API_URL}

COPY package.json yarn.lock ./
COPY packages/aave-core/package.json packages/aave-core/
COPY packages/server/package.json packages/server/
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
