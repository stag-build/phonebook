# Container image for MCP directory listings (Glama) that need to start the
# server and answer an introspection request. Phonebook's tools shell out to
# Gradle and xcodebuild against a real checkout, so this image is only good for
# handshake/tool-listing checks — not for running generate or build.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/cli.js", "mcp"]
