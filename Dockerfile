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
# Bind inside the container so `-p` still works, but the server refuses to start
# on a non-loopback address unless ACCESS_CODE is set. Run it as:
#   docker run -p 8787:8787 -e ACCESS_CODE="$(openssl rand -base64 24)" \
#     -e TRUST_PROXY=1 3am-blueprint
# and terminate TLS in front of it. Credentials are posted to /api/scan, so
# plain HTTP over an untrusted network is refused.
ENV HOST=0.0.0.0
ENV PORT=8787

# node:20-alpine ships an unprivileged "node" user; nothing here needs root.
RUN chown -R node:node /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node bin/blueprint.js serve --port \"$PORT\" --host \"$HOST\""]
