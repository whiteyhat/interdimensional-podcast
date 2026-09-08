# Pepe & Chad Live

An infinite crypto-meme podcast that reacts to the timeline. Pepe and GigaChad keep talking, pull in what is happening right now on X, and take a questionable turn into whatever the audience asks about.

Built with [fal](https://fal.ai): MiniMax H3 Max Turbo generates each speaking shot from a character image, while Gemini writes the next exchange. Live topics come from [xAI's Grok](https://x.ai) using its built-in X and web search.

![Pepe and GigaChad podcast interface](docs/screenshots/podcast.png)

## How it works

- Two fixed camera angles, generated speech, and short 5-7 second turns.
- A live news desk pulls crypto, tech and macro stories off X every few minutes and hands them to the writers with a comedic angle.
- Pasted live-chat comments are ranked and queued as topics; real platform adapters plug into the same interface.
- Three clips buffered before playback, with up to four upcoming shots prepared ahead.
- Audience prompts steer the next unwritten exchange without cutting off a speaker.
- Pause, resume, fullscreen, captions, and an optional studio details panel.

![Audience controls and generated dialogue](docs/screenshots/audience.png)

## Run locally

Requires Node.js 22.13+ and a [fal API key](https://fal.ai/dashboard/keys). An [xAI API key](https://console.x.ai) is optional: without it the show runs on audience prompts alone.

```sh
npm install
cp .dev.vars.example .dev.vars
# Set FAL_KEY, and XAI_API_KEY for live topics, in .dev.vars
npm run dev -- --host 127.0.0.1 --port 3212
```

On PowerShell, use `Copy-Item .dev.vars.example .dev.vars` instead of `cp`.

Open [localhost:3212](http://localhost:3212) and select **Tune in**. Generation uses your fal credits. The key stays on the server.

## Under the hood

React, TypeScript, Vinext, and a local Cloudflare Workers runtime. Character images are generated once, then reused for image-to-video. Edit `lib/show.ts` to change the cast, opening, voices, and writing direction.

Regenerate the character stills with `node scripts/characters.mjs` (uses fal credits, about $0.15 per image). Use `--dry-run` to see the prompts, `--variants 2` to compare candidates, and `--pick host=0 --pick guest=1` to promote them. Topic selection lives in `lib/topics.ts`; the news desk prompts are in `lib/newsdesk.ts`.

Generation is the real cost: continuous airtime runs roughly $22 per hour at MiniMax promotional pricing and about $90 per hour at list price. The news desk adds around $0.30 per hour.

The buffer smooths playback but adds a delay to audience requests. Generation can still stall or be rejected. Captions show the script; generated speech and voices can vary. Stop ends new submissions, while jobs already sent may finish. Reloading clears the session.

## Checks

```sh
node --test tests/engine.test.mjs tests/topics.test.mjs
npx tsc --noEmit
npx oxlint app lib scripts components/player.tsx components/ticker.tsx components/wire.tsx components/feed-panel.tsx
npm run build
```

Pepe the Frog and GigaChad are internet meme characters used here as parody; Pepe was created by Matt Furie and this project is unaffiliated with him or with the model GigaChad derives from. AI-generated satire, not financial advice. Live topics are summaries of public reporting and can be wrong. This repository is a local demo, not a hosted multi-user service.
