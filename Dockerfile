FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8088 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8088
CMD ["node", "server/index.mjs"]
