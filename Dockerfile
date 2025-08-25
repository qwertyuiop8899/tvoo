# Multi-stage Dockerfile for VAVOO addon

# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
# Install deps (include dev for TypeScript)
COPY package*.json ./
RUN npm ci --include=dev
# Copy sources and build
COPY . ./
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
# Copy built files only
COPY --from=build /app/dist ./dist
# Ensure cache file path exists even if empty
RUN touch dist/vavoo_catalog_cache.json
# Health and port
EXPOSE 3000
ENV PORT=3000
CMD ["node", "dist/addon.js"]
