FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV ZK_TCP_HOST=0.0.0.0
ENV ZK_HTTP_HOST=0.0.0.0
ENV ZK_TCP_PORT=4370
ENV ZK_HTTP_PORT=3030

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 4370
EXPOSE 3030

CMD ["node", "dist/index.js"]
