# Interdimensional Podcast

An infinite podcast you can interrupt with a topic. Santa and Satan keep talking, find a questionable connection, and take the conversation somewhere new.

Built with [fal](https://fal.ai): MiniMax H3 Max Turbo generates each speaking shot from a character image, while Gemini writes the next exchange.

![Santa and Satan podcast interface](docs/screenshots/podcast.png)

## How it works

- Two fixed camera angles, generated speech, and short 5-7 second turns.
- Three clips buffered before playback, with up to four upcoming shots prepared ahead.
- Audience prompts steer the next unwritten exchange without cutting off a speaker.
- Pause, resume, fullscreen, captions, and an optional studio details panel.

![Audience controls and generated dialogue](docs/screenshots/audience.png)

## Run locally

Requires Node.js 22.13+ and a [fal API key](https://fal.ai/dashboard/keys).

```sh
npm install
cp .dev.vars.example .dev.vars
# Set FAL_KEY in .dev.vars
npm run dev -- --host 127.0.0.1 --port 3212
```

On PowerShell, use `Copy-Item .dev.vars.example .dev.vars` instead of `cp`.

Open [localhost:3212](http://localhost:3212) and select **Tune in**. Generation uses your fal credits. The key stays on the server.

## Under the hood

React, TypeScript, Vinext, and a local Cloudflare Workers runtime. Character images are generated once, then reused for image-to-video. Edit `lib/show.ts` to change the cast, opening, voices, and writing direction.

The buffer smooths playback but adds a delay to audience requests. Generation can still stall or be rejected. Captions show the script; generated speech and voices can vary. Stop ends new submissions, while jobs already sent may finish. Reloading clears the session.

## Checks

```sh
node --test tests/engine.test.mjs
npx tsc --noEmit
npx oxlint app lib components/player.tsx
npm run build
```

Original folklore character designs and AI-generated comedy. This repository is a local demo, not a hosted multi-user service.
