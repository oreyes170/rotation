# Rotation: project notes for Claude

Rotation is Oliver's personal wardrobe and wear tracker. He built it because Whering and the other apps he tried didn't fit how he dresses. It's a single-user app with no backend.

Live site: https://oreyes170.github.io/rotation/ (GitHub Pages, `main` branch, root folder). He uses it on his phone (installed to the home screen) and on his computer.

## Stack and files
- Plain HTML/CSS/JS with no build step or framework, and no dependencies except Google Identity Services, which is loaded only when Drive is connected.
  - `index.html`: the shell, plus a 4-tab bottom nav (Log, Closet, Calendar, Setup).
  - `app.js`: all logic, in one file, organised by section comments.
  - `styles.css`: tokens on `:root` with a dark theme via `prefers-color-scheme`. Phone-first, so check it at 400px wide.
  - `sw.js`: service worker that serves the app from cache first. **Bump `CACHE` (`rotation-vN`) on every release** or phones keep the old version.
  - `manifest.webmanifest` and the icons.
- **Keep it a static app** that works offline. Don't add a server or a build step unless Oliver asks.

## Data model (`app.js`)
- **Storage:** IndexedDB database `rotation`, store `kv`. Each collection is saved under its own key, and `save(...keys)` writes those keys plus `settings`.
- **Collections:**
  - **`types`:** `{id, name, limit:{wears, restMonths}|null, defaultSize}`
  - **`items`:** `{id, name, typeId, brand, store, size, colors[], location, tags[], price, discountPrice, purchaseDate, estWears, limit, notes, retired, photo (JPEG data URL, ~720px), tryOns:[{id,date,r,note}], created}`
  - **`entries`** (one logged outfit): `{id, date (YYYY-MM-DD), templateId, slots:[{typeId,itemId}], itemIds[], fits:{itemId:{r,note}}, created, imported?}`
  - **`templates`:** `{id, name, slots:[typeId]}`. The default "Daily" template is T-shirt, Work shirt, Cap, Tie.
  - **`days`:** `{date: {cover:{kind:'item',itemId}|{kind:'photo',data}}}`
  - **`filters`:** `{id, name, typeIds[], tags[]}`. These are quick filters; every type also gets its own chip.
  - **`locations`:** `{id, name}`, defaulting to My place, Mom's and Girlfriend's.
  - **`purchases`:** past purchases imported from CSV, used only for auto-fill suggestions.
  - **`settings`:** `recentDays`, `cpwIncludesEstimate`, `clientId`, `driveFileId`, `autoBackup`, `lastChange`, `lastBackup`, `logLocation`.
- **Backup and import:** `snapshot()` / `applySnapshot()` handle JSON backups. A restore replaces everything except the Drive settings.

## Rules Oliver asked for (don't change without asking)
- **Wears are derived from `entries`.** The same item is counted once per date.
- **Estimated past wears (`estWears`)** add to total wears, and to cost per wear when the setting is on. They must never affect tracked history, the "worn in past X days" count, wear limits or the calendar.
- **Cost per wear** uses the discount price if there is one, otherwise the purchase price.
- **Wear limit:** after N tracked wears the item rests for M months (calendar months from the last counted wear), then a new cycle starts. `rotation()` recalculates this from the log every time, so editing history stays consistent. Wears logged during a rest still count toward totals but not toward the cycle. A per-item limit overrides the type's limit.
- **Fit** has 5 levels: too-tight, snug, good, loose, too-loose, scored -2 to 2. Each item records a fit per wear (`entry.fits`) and per try-on (`item.tryOns`). Try-ons do not count as wears. He's tracking fit while losing weight, so the trend (recent vs earlier fits) matters.
- **Location:** where an item is kept. The "Dressing at" choice on the Log screen filters the item picker to that place.
- **The item picker** hides resting and retired items by default and sorts by least recently worn.
- **Auto-fill:**
  - Type is guessed from words in the name.
  - Colours are found by sampling the photo, with the edge colour treated as background.
  - Typing a name suggests matches from imported purchases.
  - There's no online AI. That's deliberate, to keep the app offline.

## Google Drive backup
- Uses Google Identity Services with a token client and scope `drive.file`, so the app only sees files it creates. Oliver provides the OAuth client ID in Setup, and the authorised origin is `https://oreyes170.github.io`.
- The backup is one file, `rotation-backup.json`. Auto-backup runs 4 seconds after a change, but only while a token is still valid.
- **This has not been tested against a real Google account yet.**

## CSV
- **Items:** import and export. Matching is by `id`, or by name plus type. Unknown types and locations are created automatically. Tags and colours are separated with `;`.
- **Wear log:** import and export, with fit included. Imports add to the existing history.
- **Purchases:** import only, for auto-fill. Columns are `date, retailer, item, size, color, price`.
- **Keep Oliver's personal data files out of this public repo.** That includes the Whering export and the purchase history.

## Open ideas, not built
1. **Photo import from Whering:** the item image URLs are on Google Cloud Storage. Oliver parked this.
2. **Photos as separate files in a Drive folder** ("Rotation photos"), so the backup JSON stays small. Right now photos sit inside the backup, which gets big (about 200 photos ≈ 15–20 MB).
3. **Merging when both phone and computer have changes.** Today a restore replaces everything on the device, with no merge.

## Testing
- There are no automated tests in the repo. Test with Playwright against a local server: `python3 -m http.server`, then load the page and drive the UI.
- Check: adding items, logging outfits, wear limit and rest, combinations, fit, location filtering, calendar modes, CSV round trips, offline reload, 400px with no horizontal scroll, and dark mode.
