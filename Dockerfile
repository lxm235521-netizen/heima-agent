# syntax=docker/dockerfile:1
#
# The application has ZERO runtime dependencies, so there is no install step and
# no node_modules to copy — the image is just Node plus this source tree.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    H3_CONFIG_DIR=/data

WORKDIR /app

# Only what the server reads at runtime. test/ and scripts/ are intentionally
# excluded to keep the image small; copy them too if you want to run the test
# suite inside the container.
COPY package.json ./
COPY src ./src
COPY web ./web
COPY skills ./skills

# Writable state (config.local.json) lives on a volume so the app filesystem can
# stay read-only. Owned by the unprivileged `node` user that the base image provides.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# HOST from ENV is what makes the container reachable from outside.
CMD ["node", "src/server.mjs"]
