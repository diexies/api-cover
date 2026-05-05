# APICover landing v2

Experimental aesthetic rebuild of the landing page. Lives **alongside** v1 at
`landing/`. Evaluate against v1 before promoting either to production at
apicover.com.

## What's different from v1

- Editorial single-column hero (96px Cormorant display vs v1's 72px max)
- Authentic three-frame demo spread mirroring the real product UI:
  canvas with `⑂N` anchor pill, internals tree with real `[controller]` /
  `[interface]` / `[→ external HTTP]` / `[db]` badges, branch tree with
  `v1/v1` path leaves
- Editorial waitlist form: 0px-radius transparent inputs with border-bottom only
  (per the reference style guide; v1 used pill inputs which violate the rule)
- Magazine-spread "How it works" with Cormorant numerals in the margin
- Pull-quote section replaces the SaaS-style competitor diff table
- Original `⑂` monogram instead of the borrowed voice-spectrum gradient
- Subtle reveal animations via IntersectionObserver (respects
  `prefers-reduced-motion`)
- Vertical hairline rule at the right gutter on ≥1024px viewports
- Colophon footer with masthead-style issue line

## Files

- `index.html` — markup
- `styles.css` — design system + components
- `app.js` — waitlist form + reveal observer
- `assets/logo.svg` — APICover monogram
- `README.md` — this file

## Run locally

```bash
# Default port 4174 so v1 (4173) can run side by side
python3 -m http.server 4174 --directory landing/v2
```

Open `http://localhost:4174/`.

## Wire the waitlist

In `app.js`, set `ENDPOINT` to your intake URL:

```js
const ENDPOINT = "https://formspree.io/f/xxxxxxxx"; // or Tally / custom backend
```

If `ENDPOINT` is left empty, submissions are stashed in `localStorage` under
the key `apicover.waitlist.v2` so you can dev the form without a backend.
v1 uses `apicover.waitlist`, so the two stores stay separate.

## Deploy

Drop `landing/v2/` into any static host: Vercel, Netlify, Cloudflare Pages,
GitHub Pages, S3+CloudFront. No build step. No npm. No bundler.

## Fonts

Loaded from Google Fonts:
- Cormorant Garamond 300/400/500 + italic 300/400 (Waldenburg substitute)
- Inter 400/500/600/700
- JetBrains Mono 400/500
