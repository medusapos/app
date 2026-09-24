FROM node:22-bookworm-slim

ENV MEDUSA_DISABLE_TELEMETRY=true TALLY_E2E_PLUGIN=1

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/app
COPY .github/workflows/ci.yml .github/workflows/ci.yml
RUN ref=$(sed -n 's/^  TALLYUI_REF: *//p' .github/workflows/ci.yml) \
    && mkdir -p /src/tallyui \
    && curl -fsSL "https://codeload.github.com/TallyUI/tallyui/tar.gz/$ref" | tar -xz --strip-components=1 -C /src/tallyui

WORKDIR /src/app/packages/medusa-plugin
COPY packages/medusa-plugin/package.json packages/medusa-plugin/package-lock.json ./
RUN npm ci --no-audit --no-fund

WORKDIR /src/app/dev/medusa-store
COPY dev/medusa-store/package.json dev/medusa-store/package-lock.json dev/medusa-store/.npmrc ./
COPY dev/medusa-store/apps/backend/package.json apps/backend/package.json
RUN npm ci --no-audit --no-fund

COPY . /src/app
WORKDIR /src/app/packages/medusa-plugin
RUN npm run build && npm pack
WORKDIR /src/app/dev/medusa-store
RUN npm install --no-save --no-audit --no-fund /src/app/packages/medusa-plugin/medusapos-medusa-plugin-0.0.1.tgz
WORKDIR /src/app/dev/medusa-store/apps/backend
RUN npx medusa build

ENV NODE_ENV=production
WORKDIR /src/app/dev/medusa-store/apps/backend/.medusa/server
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 CMD curl -fsS http://127.0.0.1:9000/health || exit 1
CMD ["/src/app/deploy/demo-backend/start.sh"]
