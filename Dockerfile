# Two stages so the image ships dist/ and production deps only — no
# TypeScript, no tsx, no source.
FROM node:22-alpine AS build
WORKDIR /app

# Copied before the source so a code change does not re-run npm ci.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Cloud Run tells the container which port to listen on; config.ts already
# reads PORT, and this is only the local default.
ENV PORT=8080
EXPOSE 8080

# Not root: nothing here needs to write to the filesystem.
USER node

CMD ["node", "dist/index.js"]
