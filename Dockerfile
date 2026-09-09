# The broadcast box: the studio, a screen, a speaker, a browser and an encoder in one image.
# Everything the MacBook and OBS were doing, minus the MacBook.
#
# Chrome is amd64-only, so build for linux/amd64 even from an Apple Silicon machine:
#   docker build --platform linux/amd64 -t broadcast-box .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The database id baked in here is the local placeholder: the box proxies paid requests to the
# deployed site with INTERACT_ORIGIN and never opens a database of its own.
RUN npm run build

FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# xvfb is the screen, pulseaudio the speaker, ffmpeg the encoder, x11-utils tells us the screen
# is up, and the fonts are what the lower third and the captions are drawn with.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini ffmpeg xvfb x11-utils pulseaudio pulseaudio-utils \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
 && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

# A real user: Chrome refuses to run as root without a sandbox opt-out we would rather not give it.
RUN useradd --create-home --shell /bin/bash air \
 && mkdir -p /app /tmp/runtime-air \
 && chown -R air:air /app /tmp/runtime-air
WORKDIR /app
COPY --from=build --chown=air:air /app/node_modules ./node_modules
COPY --from=build --chown=air:air /app/dist ./dist
COPY --chown=air:air package.json ./
COPY --chown=air:air broadcast ./broadcast
COPY --chown=air:air scripts ./scripts

USER air
ENV XDG_RUNTIME_DIR=/tmp/runtime-air \
    HOME=/home/air \
    NODE_ENV=production \
    AIR_DISPLAY=:99 \
    AIR_HEIGHT=1080 \
    PORT=8080
EXPOSE 8080
# tini reaps Chrome's and ffmpeg's children, which otherwise pile up across a long broadcast.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "broadcast/supervisor.mjs"]
