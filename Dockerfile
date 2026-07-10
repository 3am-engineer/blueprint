FROM node:20-alpine
RUN apk add --no-cache unzip
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
# Icons: use the set bundled in the build context if present; otherwise try to
# download the official package (needs network at build time).
RUN [ -d icons ] && [ "$(ls icons 2>/dev/null | head -1)" ] || node scripts/fetch-icons.mjs aws /app/icons || true

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "bin/blueprint.js", "serve", "--port", "8787", "--host", "0.0.0.0"]
