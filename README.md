# Deck Studio

A link the sales team opens to personalise the Figma sales deck and download a PDF under 3 MB.

- **Designer** builds decks in Figma and pushes each one to the **deck library** with the Deck Studio Figma plugin.
- **Sales** opens the link, picks a deck from the library, types the client name, drags logos onto the slides, edits any text, and clicks **Download PDF**.
- Every logo anyone uploads is saved to a shared **logo library** for the whole team.

Until Figma is connected the app shows a 4-slide demo deck.

---

## For the designer: publishing a deck (no Figma API limit)

1. In Deck Studio click **For designers → Download the Figma plugin** and unzip it (one time; after an update, replace the old files with the new ones in the same folder).
2. In the Figma desktop app open any design file: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json` (one time).
3. Open the deck, press **⌘ /** (Ctrl / on Windows), run **Deck Studio – Publish**, enter the designer passcode and press **Publish**.

The plugin exports each slide from inside Figma and uploads it to Deck Studio, so it never touches the REST API or its monthly limit. Publishing with the same deck name updates that deck; a new name adds a deck to the library. Decks can be removed under **For designers**.

Spacing is kept exactly as designed: while exporting, the plugin makes editable layers transparent (it never hides them), so auto-layout frames keep every gap.

## For the designer: how to set up the Figma file

**Figma Slides files work as they are.** Every slide becomes a slide in the app, and:
- the layer named `Logo Change` (or `logo-slot`) is where the client logo goes;
- every text layer of 14 px or more is editable (smaller text inside product screenshots stays locked);
- the deck's fonts load from Google Fonts automatically (Inter, Plus Jakarta Sans, Sora…).

The table below applies to Figma Design files, and the naming tips (`{client}`, `logo-slot`, `_` to lock) work in both.

| What | How |
| --- | --- |
| Which page is the deck | Name the page `Deck – <name>` (e.g. `Deck – Enterprise pitch`). Several `Deck` pages = several decks in the app. If no page is named that way, the file's first page is used and the deck takes the file's name. |
| More decks later | Either add another `Deck – …` page to the same file, or keep it in its own file and add that file's link to `FIGMA_FILE_URL`. A deck picker appears in the app once there's more than one. |
| Slides | Every top-level frame on that page is a slide (frames inside a Section count too). Order is top-to-bottom, then left-to-right. |
| Logo spots | Draw a rectangle (or frame) and name it `logo-slot` (or `Logo Change`). Put whatever placeholder you like inside it — it disappears once a logo is dropped. Every `logo-slot` shares the same logo. For a second logo, name it `logo:partner`. |
| Client name | Write `{client}` inside any text, e.g. `Why {client} needs Intervue`. Any `{word}` becomes a field. |
| Editable text | Every text layer is editable. Start a layer's name with `lock` or `_` to stop sales editing it. |
| Text that changes length | Give the text box the size the copy is allowed to take. Longer text shrinks to fit that box instead of running into what's below it. |

Text that isn't changed stays exactly as Figma rendered it. Edited text is redrawn with the font named in Figma — add the font files to `public/fonts` (instructions inside `fonts.css`).

## For sales

1. Open the link.
2. Type the client name — it fills in on every slide.
3. In **Logo library**, paste the company website and click **Find logo**, or upload a logo yourself. The lookup prefers structured logo metadata, then page logo images, then site icons. Logo discovery also handles responsive and lazy-loaded images, inline SVG/data images, app manifest icons, compressed responses, and direct image links. GIF, AVIF, TIFF and ICO assets are converted to static PNGs. When the homepage blocks requests, site-owned favicon paths are tried, followed by Google’s cached site icon. This fallback sends only the public hostname to Google and rejects the generic placeholder. Sites without any discoverable or cached icon still need a manual image drop. Logos are saved and deduplicated using the same library as uploads.
4. Drag a logo from the library onto any dashed box (or drop an image file straight from your computer onto the box). It's applied to every logo spot in the deck.
5. Click any text on the slide to edit it.
6. **Download PDF**. The file is always under 3 MB; edits are saved in your browser until you press **Start over**.

---

## Deploying on Vercel

### Supabase storage

The preferred backend is Supabase when `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, and `SUPABASE_STORAGE_GATEWAY_TOKEN` are all configured. Until then the existing Blob/R2 configuration continues to work. Do not enable Supabase in production before the copy and checksum verification finish.

The `deck-studio-storage` Edge Function authenticates the server using a bucket-scoped token (only its SHA-256 hash is committed). Supabase's administrative key stays inside the Edge Function environment and is never sent to Vercel or a browser. Reads, uploads, listing, and deletes are restricted to the `deck-studio` bucket. Public downloads use Supabase's CDN, matching the previous public Blob behavior. The SQL inventory function is executable only by `service_role`.

Migration commands use a gitignored `.env.migration.local` containing the Blob token and Supabase server settings:

```bash
node --env-file=.env.migration.local scripts/migrate-storage.mjs inventory
node --env-file=.env.migration.local scripts/migrate-storage.mjs bootstrap
node --env-file=.env.migration.local scripts/migrate-storage.mjs backup
node --env-file=.env.migration.local scripts/migrate-storage.mjs copy
node --env-file=.env.migration.local scripts/migrate-storage.mjs verify
```

The backup, inventory, and checksum reports stay in gitignored `.migration/`. All original Blob files are retained. JSON documents are copied with old Blob asset addresses replaced by the app's stable `/api/files/` addresses. Original upload dates are preserved in Supabase object metadata. After verification, re-list Blob and compare the inventory to catch any concurrent changes; repeat the copy if needed. Then enable the Supabase variables in Vercel and deploy. To roll back, remove these three variables and redeploy; the Blob store must be readable for rollback to work.

Connection smoke test (creates and deletes one temporary object):

```bash
node --env-file=.env.migration.local --experimental-strip-types scripts/check-supabase-storage.mjs
```

The `Supabase storage health` GitHub workflow runs every eight hours and after workflow changes. It calls the JWT-protected `deck-studio-health` function, which performs an actual database query and bucket check. Only the public anon key is used by GitHub. Failures appear as failed workflow runs; GitHub notification delivery follows the repository owner's settings. No paid monitoring service is required. Scheduled GitHub workflows can be delayed, and public-repository schedules are disabled after 60 days without repository activity. Supabase does not guarantee that periodic queries prevent free-plan pausing.

### Original Blob setup

1. Push this folder to a GitHub repo and import it in Vercel (framework: Next.js).
2. **Storage → Create → Blob**, and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN` (logo library + synced slides live here).
3. **Settings → Environment Variables**:
   - `FIGMA_TOKEN` — Figma → Settings → Security → Personal access tokens, scope *File content: read*.
   - `FIGMA_FILE_URL` — the link to the deck file. For decks in separate files, put all the links here separated by commas.
   - `ADMIN_KEY` — a passcode the designer types to sync (optional but recommended).
4. Redeploy, open the site, press **Sync from Figma**.

To keep the link internal, turn on **Deployment Protection** (Vercel Authentication or a password) in project settings.

## Figma API limits

Figma limits API calls by the plan and seat of whoever created the token. On the **Starter plan** (or a View/Collab seat) that's about **20 calls a month**; a sync of a Slides file uses 2, so roughly 10 syncs a month. A token from a **Dev or Full seat on a Professional plan** allows 10 calls a minute. If the limit is hit, the sync dialog says how long Figma has paused access.

## Local development

```bash
npm install
cp .env.example .env.local   # optional: add Figma details to test syncing
npm run dev
```

Without a Blob token, files are stored in `.data/`.

## How it works

- `lib/figma.ts` reads the file through the Figma REST API, exports each frame as SVG with `data-node-id` on every layer, and records each text layer's position and style plus each `logo-slot`.
- In the browser (`lib/render.ts`), each slide is drawn from that SVG. Edited layers are removed from the SVG and redrawn on top with the new text; logos are fitted inside their slot.
- `lib/pdf.ts` renders every slide at 1920 px, then steps JPEG quality / size down until the PDF is under 3 MB.

Logo lookup stays inside the Next.js `/api/logos` route; no API key or separate backend is required. Each outbound request validates public IP addresses (including redirects), pins DNS resolution, and uses time and size limits. Run its tests with `node --experimental-strip-types --test tests/website-logo.test.mjs` (Node 22.22.2+).

Logo lookup errors include a stable `code`: invalid/private URLs return 400, upstream access blocks or connection errors return 502, timeouts return 504, and a readable website with no usable logo returns 422. No API key is needed; the last fallback uses Google’s cached favicon endpoint. This version requires Node 22.22.2+ for the ICO decoder.
