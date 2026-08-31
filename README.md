# Daily Deck

A personal, finite knowledge feed: ~25 cards a day, rewritten by AI to actually
be worth reading, then a hard "you're done" screen. No infinite scroll, no
engagement metrics, no accounts.

## How it works

- **Pipeline** (`pipeline/`) runs on the Mac via launchd whenever it's awake,
  at most once per day: fetches the source roster, has Claude (headless
  `claude -p`, billed to the Max subscription — no API key) score and rewrite
  every item, assembles a ~25-card deck, and pushes it as static JSON.
- **App** (`src/`) is a PWA served by GitHub Pages: snap-scroll cards, save
  button, "go deeper" links. If no deck exists for today it builds an
  evergreen fallback in the browser from free CORS APIs.

## Commands

```bash
npm run dev          # local app dev server
npm run deck         # build today's deck (no push)
npm run deck:push    # build + commit + push (what launchd runs)
bash scripts/install-launchd.sh   # install the automatic schedule
```

Tune the feed in `pipeline/profile.json` (interests, tone, quotas, model)
and `pipeline/sources.mjs` (the source roster).
