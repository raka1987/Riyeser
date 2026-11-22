# riyeser.com

The Riyeser Group website: home, a page per program, Downloads, Pricing (free during early access) and Support.

- **Edit**: all text lives in `build.mjs` (one place for every page); styling in `assets/site.css`.
- **Build**: `node website/build.mjs` → `website/public/` (plain HTML, works on any web host).
- **Publish**: Actions → *Publish website* → *Run workflow* (the workflow lives on `main`; it builds this folder from `module/desk-assistant`).
- **Use riyeser.com**: at your domain registrar add `A` records for `@` → 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153 and a `CNAME` for `www` → `raka1987.github.io`; then in Settings → Pages enter `riyeser.com` and tick *Enforce HTTPS*.
- **Download buttons** point to `https://github.com/raka1987/Riyeser/releases/latest/download/<file>`; each release must include
  `RiyserCentral-Setup.exe`, `RiyeserDeskAssistant-Setup.exe`, `RiyserPDF-Setup.exe` and `RiyeserAccounting-Setup.exe`.
- **Contact address** used on the site: info@riyeser.com (change `EMAIL` in `build.mjs`).
