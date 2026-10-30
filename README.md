# prod-test

Working copy of [ATS-X2-prod](https://github.com/tangiblethinking/ATS-X2-prod) (full history, copied at `ecafa2c`).
All new work happens here first, then gets copied into
[ATS-X2-prod-main](https://github.com/tangiblethinking/ATS-X2-prod-main), which serves the app at `/jobs`.

## Running under `/jobs`

This repo uses the **exact same `/jobs` setup as ATS-X2-prod-main**, so any file can be copied
into prod-main as-is. The only differences from ATS-X2-prod (which uses `/job`) are these 4 files:

| File | What it does |
| --- | --- |
| `vite.config.ts` | `base: "/jobs/"` so built JS/CSS links point at `/jobs/assets/...`; `tanstackStart({ router: { basepath: "/jobs" } })` so server-function calls go to `/jobs/_serverFn/...`. |
| `src/router.tsx` | `basepath: "/jobs"` so pages and internal links match `/jobs`, `/jobs/...`. |
| `vercel.json` | Rewrites `/jobs`, `/jobs/assets/*`, `/jobs/_serverFn/*`, `/jobs/__grok/*` and `/jobs/*` to the app's real files at the root. |
| `src/components/support-bot.tsx` | Mascot video path `/jobs/mascot/...` (files in `public/` are not prefixed automatically). |

Rules when changing code here:

- Do not edit the 4 settings above. They must stay identical to ATS-X2-prod-main.
- Any hard-coded path to a file in `public/` must start with `/jobs/`.
- Internal page links use the router (`<Link to="/">`), never a hard-coded `/jobs/...` href; the router adds `/jobs` itself.

Open the app at `<deployment-url>/jobs` (the root `/` is not the app's home page).

## Copying a change into ATS-X2-prod-main

Copy the changed files from prod-test into ATS-X2-prod-main. Do not copy files from ATS-X2-prod
(the `/job` repo): its 4 files above would break `/jobs`.
