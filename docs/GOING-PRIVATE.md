# Making the Riyeser code private (without breaking downloads)

This guide moves everything the public needs (the installers, the update information and the website) into a new
**public** repository called `raka1987/riyeser-downloads`. After that, the code repository `raka1987/Riyeser` can be
made **private**. Customers won't notice: downloads, automatic updates in Riyeser Central, the download counter,
Riyeser HQ's download numbers and riyeser.com keep working.

**What goes in the new public repository:** only the releases (the installer files and `versions.json`, with the same
names as today) and the finished website files. **No source code ever goes there.** All the building still happens in
the code repository, as it does now.

Do the steps in order. Each step says how to undo it if something looks wrong.

---

## Before you start: GitHub Actions minutes

GitHub Actions (the "Run workflow" buttons) is free without limit for **public** repositories. For a **private**
repository you get a monthly allowance of minutes with your GitHub plan (at the time of writing, 2,000 minutes a
month on GitHub Free and 3,000 on GitHub Pro; check github.com/pricing, as this changes). Two things to know:

- **Windows minutes count double** (1 real minute uses 2 of your minutes), and **macOS minutes count ten times**.
- A release builds and checks everything on Windows, so each release uses a noticeable share of the allowance.

To keep usage down, the automatic checks now run only when something they check has changed:

- "Riyeser Central + Documents + PDF + As Built + Link + Link Office (Windows)" runs by hand, on changes to the
  desktop programs (a push to `module/desk-assistant` or a pull request into it that changes `desktop/`), and when
  another workflow calls it before a release. A newer push stops the older run.
- "Build desktop app" runs by hand, on `v*` tags, and on pushes to `main` that change the Accounting/POS/Invoices/
  Bookings/Estimate programs (`riyeser/`, `packaging/`, `tests/`, `pyproject.toml`, `run.py`, the licence function).
  Pushes that only change documents or other workflows no longer start it.

After the first month as private, look at **Settings → Billing and plans → Usage** (your account settings) to see how
many minutes were used. If you're running short, GitHub lets you set a spending limit (the default limit of $0 means
work simply stops until next month; nothing is charged).

---

## Step 1. Create the public downloads repository

1. Go to **github.com/new**.
2. **Owner:** `raka1987`. **Repository name:** `riyeser-downloads` (exactly this; the code uses this name).
3. **Description:** `Riyeser installers and website. Source code is not published here.`
4. Choose **Public**.
5. Tick **Add a README file**. (This matters: GitHub can't add a release to an empty repository.)
6. Leave ".gitignore" as **None** and "license" as **None**.
7. Click **Create repository**.
8. In the new repository, open **Settings → General** and, under "Features", untick **Wikis**, **Issues**,
   **Discussions** and **Projects** (nothing needs them there). Leave the rest as it is.
9. Open **Settings → Actions → General** and choose **Disable actions** (nothing runs in this repository; the code
   repository does all the work), then **Save**.

Don't add any files yourself. Releases are added by "Publish Riyeser release", and the website by "Publish website".

**Undo:** Settings → General → Danger zone → **Delete this repository** (only before step 5; after that it holds the
releases that downloads use).

---

## Step 2. Create the token that lets the code repository publish there

1. Click your picture (top right) → **Settings** → **Developer settings** (at the bottom of the left menu) →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `Riyeser DOWNLOADS_TOKEN`.
3. **Description:** `Lets Riyeser's workflows publish releases and the website to riyeser-downloads.`
4. **Resource owner:** `raka1987`.
5. **Expiration:** choose **Custom** and pick a date one year from today (the longest GitHub allows).
6. **Repository access:** choose **Only select repositories** and pick **raka1987/riyeser-downloads** (only that one).
7. **Permissions → Repository permissions:** set **Contents** to **Read and write**. GitHub adds **Metadata:
   Read-only** by itself; that's expected. **Leave every other permission at "No access".**
8. Click **Generate token**, then **copy** the token. GitHub shows it only once. Don't paste it anywhere except the
   secret in step 3 (not in a chat, email or document).

**Expiry reminder:** put a reminder in your calendar a week before the expiry date. GitHub also emails you before it
expires. When it expires, "Publish Riyeser release" stops in its first minute with the message "DOWNLOADS_TOKEN can't
see raka1987/riyeser-downloads". To renew: open the token (same place as above) → **Regenerate token**, then update the
secret (step 3, using **Update** on the existing secret).

**Undo:** same place → open the token → **Delete**.

---

## Step 3. Save the token as the DOWNLOADS_TOKEN secret

1. Open the code repository **raka1987/Riyeser** → **Settings** → **Secrets and variables** → **Actions**.
2. On the **Secrets** tab click **New repository secret**.
3. **Name:** `DOWNLOADS_TOKEN`. **Secret:** paste the token from step 2.
4. Click **Add secret**.

GitHub never shows a secret again, and the workflows never print it.

**Undo:** click the bin icon next to `DOWNLOADS_TOKEN`. (Releases then stop at their first step with a plain message.)

---

## Step 4. Merge the changes

Ask the lead to merge:

- `feat/downloads-repo` into `main` (the workflows, the download counter, Accounting's download links, this guide),
- `feat/downloads-repo-desk` into `module/desk-assistant` (Riyeser Central's update check, the website, Riyeser HQ,
  the Windows checks),
- `feat/downloads-repo-payroll` into `module/payroll` (the copyright notice only).

Merging changes **nothing live**: the website isn't rebuilt, the download counter isn't redeployed, and programs
already installed on PCs are untouched. Everything that reads releases from the new repository also falls back to
the old one while the new one has no releases, so nothing breaks in between.

**Undo:** the lead reverts the merges.

---

## Step 5. Publish a release (both repositories get it)

1. Code repository → **Actions** → **Publish Riyeser release** → **Run workflow**. Leave **"Also publish to this code
   repository"** ticked. Click **Run workflow**.
2. The first job, "Downloads repository access", checks the token in a few seconds. If it fails, its message says
   what to fix (missing secret, wrong repository, empty repository).
3. When the run finishes, check that **both** pages show the same new release with the same files:
   - `github.com/raka1987/riyeser-downloads/releases`
   - `github.com/raka1987/Riyeser/releases`
4. Then **Actions → Deploy download counter → Run workflow**. Its last step checks that a download now goes to
   `riyeser-downloads`. (If it warns that downloads still come from the old repository, step 5 hasn't finished yet.)

What happens on customers' PCs: older Riyeser Central (1.9.0 and before) still looks in the code repository, finds
this release there and updates itself. The new Riyeser Central in this release looks in `riyeser-downloads` first
(and in the code repository only if `riyeser-downloads` has nothing).

**Undo:** in `riyeser-downloads` → Releases → the release → **Delete** (the copy in the code repository stays, so
nothing installed is affected). To undo the download counter, the lead reverts step 4 and you run "Deploy download
counter" again.

---

## Step 6. Move the website to the downloads repository

The website stays at **riyeser.com**. **DNS doesn't change**: Cloudflare keeps pointing riyeser.com at GitHub Pages'
addresses (185.199.108.153 to 185.199.111.153, and `www` at `raka1987.github.io`). Both repositories are on GitHub
Pages, so only the repository that "claims" riyeser.com in its Pages settings changes. Expect a few minutes when the
site may show a GitHub "404" between b and c below, so do this at a quiet time.

a. Code repository → **Actions** → **Publish website** → **Run workflow**. Set **target** to **downloads-repo** and
   **layout** to the one you normally use (website, unless you've been told to use combined). Click **Run workflow**.
   This puts the finished website on the `gh-pages` branch of `riyeser-downloads`. The live site doesn't change yet.

b. Code repository **raka1987/Riyeser** → **Settings** → **Pages** → under "Custom domain" click **Remove**.
   (GitHub lets only one repository use riyeser.com.)

c. **raka1987/riyeser-downloads** → **Settings** → **Pages**:
   - **Source:** **Deploy from a branch**. **Branch:** `gh-pages`, folder **/ (root)**. Click **Save**.
   - **Custom domain:** type `riyeser.com`, click **Save**, and wait for "DNS check successful".
   - Tick **Enforce HTTPS** when GitHub allows it (it can take a while for GitHub to get the certificate; until then
     the box is greyed out).

d. Check: open riyeser.com, open Downloads and download one program, and open the Release notes page.

e. From now on, always choose **target: downloads-repo** when you run "Publish website". (The lead can later make it
   the default; it's one line in `publish-website.yml`.)

Optional but recommended: verify the domain so no other GitHub account can ever claim it: your picture → **Settings →
Pages** → **Add a domain** → `riyeser.com`, then add the TXT record GitHub shows in Cloudflare. (This adds a record; it
doesn't change the existing ones.)

**Undo:** in `riyeser-downloads` → Settings → Pages → Custom domain → **Remove**; in the code repository → Settings →
Pages → Custom domain → `riyeser.com` → **Save**; then run "Publish website" with **target: code-repo**.

---

## Step 7. Wait about two weeks

Riyeser Central checks for updates while it's open (every few hours). Give PCs about **two weeks** to install the new
Riyeser Central, which reads from `riyeser-downloads`. Keep publishing releases normally in the meantime (both
repositories keep getting them).

If Riyeser HQ shows which Central versions are in use, check that most PCs have the new one before step 8.

**Undo:** nothing to undo; this is just waiting.

---

## Step 8. Make the code repository private

1. Optional first check: code repository → **Insights → Forks**. Copies others made while it was public (forks)
   stay with their owners; GitHub doesn't remove them.
2. Code repository **raka1987/Riyeser** → **Settings** → **General** → scroll to **Danger zone** → **Change
   repository visibility** → **Change to private** → confirm.

What changes:

- The public can no longer see the code, its releases or its Actions. Downloads, updates and the website come from
  `riyeser-downloads`, so they keep working.
- A PC that never updated past Riyeser Central 1.9.0 stops finding updates (it says no release was found). Installing
  Riyeser Central once from riyeser.com fixes it, keeping the data.
- Old links to `github.com/raka1987/Riyeser/releases/...` (for example in old emails) stop working. riyeser.com's
  Download buttons don't use them.
- Stars and watchers of the code repository are removed by GitHub.
- Riyeser HQ → System health can't read the backup and restore job results any more without signing in (it shows
  that it couldn't check); the **GitHub jobs** button still opens them for you when you're signed in to GitHub.
- GitHub Actions minutes now count (see "Before you start" above).

**Undo:** the same place → **Change to public**. (Stars and watchers removed in step 8 don't come back.)

---

## Step 9. Stop the extra copy in the code repository

Once the code repository is private, its copy of each release is invisible to the public, so it's no longer needed.

1. Code repository → **Settings** → **Secrets and variables** → **Actions** → the **Variables** tab → **New repository
   variable**.
2. **Name:** `ALSO_CODE_REPO`. **Value:** `false`. Click **Add variable**.

From the next release on, releases go only to `riyeser-downloads`. (You can also untick "Also publish to this code
repository" for a single run.) Riyeser HQ's raw GitHub download counts keep adding up both repositories, so older
releases still count.

**Undo:** delete the `ALSO_CODE_REPO` variable (or set it to `true`).

---

## Keeping GitHub out of what the public sees (the "ship clean" change)

So that nothing shipped to the public reveals where the code lives or that it's built on GitHub, three branches
(`feat/ship-clean` on `main`, `feat/ship-clean-desk` on `module/desk-assistant`, `feat/ship-clean-payroll` on
`module/payroll`) make these changes. They don't change prices, plans or any program's behaviour.

**The website doesn't publish its own version information instead of asking GitHub.**

- The build (`website/build.mjs`) writes `versions.json` into the site: the program versions in the newest release.
- "Publish Riyeser release" writes `versions.json` and a small `releases.json` (recent releases, tag and date only)
  to the root of the downloads repository's `gh-pages` branch after each release (best-effort: a problem there never
  fails the release). "Publish website" carries the live `releases.json` across a site rebuild and installs the build
  tools so the output is minified.
- The Release notes page and the version checks read `/versions.json` and `/releases.json` first and only fall back to
  `api.github.com` (the public downloads repository) if those aren't there yet, so the site keeps working throughout.

**The built website is minified; the source stays readable.** `website/minify.mjs` strips HTML comments and minifies
the inline and served JavaScript (terser) and CSS (csso) in `website/public` only — the software site, Riyeser HQ,
Riyeser Link (`/link/`, `/team/`), As Built (`/app/`), the booking page and the widget. No source maps. `terser` and
`csso` are `website/` devDependencies; without them the build still runs (comments stripped, JS/CSS left as-is).

**The desktop and Payroll installers carry no readable source.** At packaging time the apps' own JavaScript is
minified with terser (comments dropped, local names mangled, no source maps; `node_modules` untouched):
`desktop/scripts/minify-app.js` (run by `package-win.js`, packed by `builder.config.js`) and
`module/payroll` `desktop/minify-app.js` (run by `prepare.js`). The Accounting/POS/Invoices/Bookings/Estimate
PyInstaller build (`packaging/build_desktop.py`) builds at optimisation level 2 (`--optimize 2`, same as `python -OO`):
docstrings and asserts are stripped and only `.pyc` is bundled (nothing in `riyeser/` relies on them at runtime).

**No github.com in anything the public sees (user-visible strings), except the technical update/download endpoints
that need the public downloads repository.**

- Website: the "Every release is published on GitHub" link and the "Latest releases on GitHub" heading are gone
  (plain "Release notes" / "Recent releases"); Download buttons go to `riyeser.com/download/<program>.html` (the
  download counter), never a github.com URL in the page; the code repository's name is never written into a shipped
  page (the `OLD_REPO` fallback was dropped from the pages' own fetches).
- Desktop: Riyeser Central's About box says "checks online for updates" instead of naming GitHub; the installers'
  "URL info" is `https://riyeser.com` (electron-builder `homepage`), so it never falls back to the git remote.
- The apps' in-app "Download" buttons (`riyeser/edition.py`) send people to `riyeser.com/download/<program>.html`
  instead of a github.com installer URL.
- Kept (technical, and pointing only at the **public** downloads repository): the update/download code's
  `api.github.com` and `github.com/<downloads repo>/releases/...` URLs in Riyeser Central (`updates.js`), the download
  counter (`supabase/functions/download`), and the download hand-off page's no-JS fallback.

**What still, unavoidably, shows the public downloads repository.** When a browser actually downloads an installer it
follows a redirect to `github.com/raka1987/riyeser-downloads/releases/...`, so that URL — and the GitHub username
`raka1987` in it — is visible in the browser's network activity. Riyeser HQ (staff-only, at `/hq/`, not indexed) still
links to the code repository's Actions for staff ("GitHub jobs"). To make these read `github.com/riyeser/…` instead of
`github.com/raka1987/…`, the repositories can be moved to a free GitHub **organisation** named `riyeser` (Settings →
transfer ownership; the downloads repository's name stays `riyeser-downloads`). Update `DOWNLOADS_REPO`/`OLD_REPO` in
the places listed below after the move.

---

## For the lead: where the repository name lives

One constant per codebase, so the name is easy to change:

| Where | Constant |
|---|---|
| `.github/workflows/publish-release.yml`, `publish-website.yml`, `hq-downloads.yml` (main) | `DOWNLOADS_REPO` (env) |
| `.github/workflows/desk-assistant-windows.yml` (module/desk-assistant) | `DOWNLOADS_REPO`, `OLD_REPO` (env) |
| `riyeser/edition.py` (main) | `DOWNLOADS_REPO` |
| `supabase/functions/download/handler.ts` (main) | `REPO`, `OLD_REPO` |
| `desktop/src/central/updates.js` (module/desk-assistant) | `DOWNLOADS_REPO`, `OLD_REPO` |
| `website/build.mjs` (module/desk-assistant) | `DOWNLOADS_REPO`, `OLD_REPO` |
| `website/hq/hq.js` (module/desk-assistant) | `DOWNLOADS_REPO` (releases), `REPO` (the code repository's jobs) |
| `website/team/team.js` (module/desk-assistant) | `REL` |
| `.github/workflows/deploy-download-function.yml` (main) | the address check in its last step |

`OLD_REPO` (the code repository) is only a fallback while `riyeser-downloads` has no release; it can be removed once
the code repository is private and step 9 is done. "Build desktop app" (`desktop.yml`) still attaches its files to a
release in the code repository on `v*` tags; the website and Riyeser Central don't use those.
