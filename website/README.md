# riyeser.com

The Riyeser Group website: home, a page per program, Downloads, Pricing (free programs, and every paid program free for 90 days, then one price per business per month in US dollars), What works today (the feature register), Trust & security, Hardware, Countries, Release notes, Help Centre and Terms.

- **Feature register**: `content/features.mjs` is the one list of what each program does, its status (Available, Beta, Planned, Not supported), where it runs, whether it needs the internet, and the Basics/Plus and Link/Link Office comparisons. Program pages, the comparisons and features.html are built from it: change a feature there.
- **Search engines**: set `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION` when building (or put the codes in `VERIFY` in `build.mjs`) to add the ownership tags to the home page.
- **Logo**: the wordmark ("Riyeser." with the swoosh) is `assets/logo-wordmark.svg` (navy, for light backgrounds) and `assets/logo-wordmark-light.svg` (white, for dark backgrounds); the header and footer draw it inline from the first. The favicon/app icon is still the "R" (`assets/favicon.png`, `assets/logo-r.png`).
- **Edit**: page text lives in `build.mjs`; the Help Centre guides (one per program) in `help.mjs`; styling in `assets/site.css`; program icons in `assets/apps/`.
- **Build**: `node website/build.mjs` → `website/public/` (plain HTML, works on any web host).
- **Publish**: Actions → *Publish website* → *Run workflow* (the workflow lives on `main`; it builds this folder from `module/desk-assistant`). Its *target* is this code repository's Pages (`code-repo`, for now) or the public `riyeser-downloads` repository's `gh-pages` branch (`downloads-repo`, before the code repository goes private: `docs/GOING-PRIVATE.md` on `main`).
- **Use riyeser.com**: at your domain registrar add `A` records for `@` → 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153 and a `CNAME` for `www` → `raka1987.github.io`; then in Settings → Pages enter `riyeser.com` and tick *Enforce HTTPS*.
- **Download buttons** point to `https://github.com/raka1987/riyeser-downloads/releases/latest/download/<file>` (the public downloads repository; `DOWNLOADS_REPO` in `build.mjs`, see `docs/GOING-PRIVATE.md` on `main`); each release must include
  `RiyeserCentral-Setup.exe`, `RiyeserDeskAssistant-Setup.exe`, `RiyeserPDF-Setup.exe`, `RiyeserAccountingBasics-Setup.exe`, `RiyeserAccountingPlus-Setup.exe`, `RiyeserPOS-Setup.exe` and `RiyeserLinkOffice-Setup.exe`.
- **Contact address** used on the site: info@riyeser.com (change `EMAIL` in `build.mjs`).

## One site on riyeser.com (Services + Riyeser Group website)

- `website/services/` is Riyeser Services exactly as it was on riyeser.com (copied from the live site, plus a *Software* link in its menus).
  Its data stays in Supabase (`config.js`), so projects and logins carry on.
- `node website/build-combined.mjs` puts Services at `/` and this website at `/software/` (the Services app must be at the top of the domain).
- Publish: Actions → *Publish website* → Run workflow → layout **combined** (only once riyeser.com points at GitHub Pages).
- Changes to Riyeser Services now go into `website/services/` and are published the same way.
