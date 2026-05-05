# APICover landing

Static landing page for apicover.com. Eggshell ground, near-zero saturation,
hairline shadows, type-first — ElevenLabs aesthetic.

## Files

- `index.html` — page markup
- `styles.css` — design system + components
- `README.md` — this file

## Run locally

Any static server. Examples:

```bash
# Python
python3 -m http.server 8080 --directory landing

# Node (one-off)
npx --yes serve landing -p 8080
```

Open `http://localhost:8080`.

## Wire the waitlist

In `index.html`, find the script block and set `ENDPOINT` to your intake URL:

```js
const ENDPOINT = "https://formspree.io/f/xxxxxxxx"; // or Tally / custom backend
```

If `ENDPOINT` is left empty, submissions are stashed in `localStorage`
under the key `apicover.waitlist` so you can dev the form without a backend.

## Deploy

Drop `landing/` into any static host: Vercel, Netlify, Cloudflare Pages,
GitHub Pages, S3+CloudFront. No build step.

## Fonts

Loaded from Google Fonts:
- Cormorant Garamond 300 (Waldenburg substitute, per the reference style guide)
- Inter 400/500/700
- JetBrains Mono 400
