# Rotation: project notes for Claude

Rotation is a personal wardrobe and wear tracker, built because the existing wardrobe apps didn't fit how the owner dresses. It's a single-user app with no backend.

**This repo is public.** Keep personal details out of everything committed here, notes included: no names, places, health details, or the owner's own data. Talk about "the owner".

Live site: https://oreyes170.github.io/rotation/ (GitHub Pages, `main` branch, root folder). The owner uses it on a phone (installed to the home screen) and on a computer.

## Stack and files
- Plain HTML/CSS/JS with no build step or framework. Dependencies: Google Identity Services (loaded only when Drive is connected) and tesseract.js for reading screenshots, which the owner approved. It's vendored in `vendor/tesseract/` (about 7 MB downloaded on first use: script, worker, the SIMD or plain LSTM core, English `best_int` model), loaded only when "Read screenshots" is used.
  - `index.html`: the shell, plus a 4-tab bottom nav (Log, Closet, Calendar, Setup). The page itself never scrolls; `<main id="view">` is the scroller (iOS shifted bottom-fixed bars when the whole page scrolled), so scroll `view()`, not `window`. The app doesn't draw under the iPhone status bar (no `viewport-fit=cover`): iOS blurred whatever sat beneath it, so the header looked smeared. iOS paints that strip with `theme-color`, which `applyTheme()` sets per theme (`THEME_BAR`) to match the header. iOS doesn't always repaint when the tag's content changes, so `applyTheme()` swaps in a fresh `<meta>` (again whenever the app comes back to the foreground), and `index.html` sets the saved colour (`rotation-bar` in localStorage) before first paint. Sheets (`openModal`) size with plain CSS (`max-height:92dvh`); don't size them from `window.visualViewport`, which the iPhone home-screen app reports wrongly (it caused sheets that were cut off, unscrollable or hidden under the keyboard). On Log, while the outfit being built has items, Save lives in a bar docked above the tab bar (`saveDock`, `#savedock`), whose buttons press the form's own hidden ones. Sheets you type into open from the top (`openModal(..., { top: true })`, used by the item picker) so the keyboard can't cover their results. Swiping left/right changes the day on Log and the month on Calendar.
  - `app.js`: all logic, in one file, organised by section comments.
  - `styles.css`: tokens on `:root` with a dark theme via `prefers-color-scheme`, plus themes picked in Setup → Look (`settings.theme`: auto, light, dark, oled "True black (OLED)" (pure black background and bars), brown "Chocolate", ipod "Click Wheel" (original iPod LCD look, white-backlit grey, Pixelify Sans font from `vendor/fonts/`, OFL), aqua "Aqua", luna "Luna" (Windows XP), blades "Blades" (original Xbox 360 dashboard: lime waves, thin lowercase type, flat panels), channels "Channels" (Nintendo Wii menu: pinstripes, grey-framed tiles, blue highlight ring, rounded font), aero "Aero" (Windows Vista), ocarina "Ocarina" (classic 3D fantasy-adventure game menus: night forest with drifting embers and fairy motes (CSS only, off with reduced motion), deep green panels with gold frames, blue main button, yellow selection), w98 "Retro 98" (Windows 98); look only, no logos or wallpapers) applied as `data-theme` on `<html>`. The choice is mirrored in localStorage so `index.html` applies it before first paint. Setup → Look also has "Items per row" (`settings.cols`, 3 by default, 2 or 3 on phones, `data-cols` on `<html>`) and a "Glass tab bar" switch (`settings.glass`, on by default, `data-glass` on `<html>`): a floating, frosted pill tab bar, styled per theme. Phone-first, so check it at 400px wide.
  - `sw.js`: service worker that serves the app from cache first. **Bump `CACHE` (`rotation-vN`) on every release, and `VERSION` at the top of `app.js` to the same N** (it's shown in the header; tap it to check for updates). A new version installs with fresh files and reloads the app once it takes over.
  - `sw.js` keeps `vendor/` files in a separate cache (`rotation-vendor-N`) that survives app updates, so the reader is downloaded once; bump N only when those files change.
  - `manifest.webmanifest` and the icons.
- **Keep it a static app** that works offline. Don't add a server or a build step unless the owner asks.

## Data model (`app.js`)
- **Storage:** IndexedDB database `rotation`, store `kv`. Each collection is saved under its own key, and `save(...keys)` writes those keys plus `settings`.
- **Collections:**
  - **`types`:** `{id, name, limit:{wears, restMonths}|null, defaultSize, group}`. Defaults: Short-sleeve tee, Long-sleeve tee and Jersey (group "Tees"), then Work shirt, Cap, Tie, Shoes, Pants, Jacket, Other.
  - **`items`:** `{id, name, typeId, brands[], store, size, colors[], materials[], madeIn[], location, tags[], link, price (what was paid), fullPrice (list price, if bought on sale), purchaseDate, estWears, limit, notes, retired, snooze (picker "Not now" until this date), photo (JPEG data URL, ~720px), tryOns:[{id,date,r,note}], created}`
  - **`entries`** (one logged outfit): `{id, date (YYYY-MM-DD), templateId, slots:[{typeId,itemId}], itemIds[], fits:{itemId:{r,note}}, noWear?:[itemId], created, imported?, planned?}`
  - **`templates`:** `{id, name, slots:[typeId]}`. The default "Daily" template is Short-sleeve tee, Work shirt, Cap, Tie.
  - **`days`:** `{date: {cover:{kind:'item',itemId}|{kind:'photo',data}}}`
  - **`filters`:** `{id, name, typeIds[], tags[]}`. These are quick filters; every type also gets its own chip.
  - **`locations`:** `{id, name}`, defaulting to Home. The owner adds their own places on the device.
  - **`purchases`:** past purchases imported from CSV, used only for auto-fill suggestions.
  - **`settings`:** `recentDays`, `cpwIncludesEstimate`, `clientId`, `driveFileId`, `autoBackup`, `lastChange`, `lastBackup`, `logLocation`, `theme`, `glass`, `cols`, `pickSort`, `tagLibrary` (extra tags to suggest, added in Setup), `schema` (data version; `load()` runs one-off upgrades when it's behind).
- **Backup and import:** `snapshot()` / `applySnapshot()` handle JSON backups. A restore replaces everything except the Drive settings.

## Rules the owner asked for (don't change without asking)
- **Wears are derived from `entries`.** The same item is counted once per date. Use `worn()` and `counts(e, id)`, not `S.entries`/`itemIds`, for anything that counts wears.
- **Not counted:** an outfit (checkbox when logging) or a single piece (checkbox in the piece's sheet) can be marked "Don't count as a wear", stored in `entry.noWear`. It still shows on the calendar and the day, but never counts toward wears, limits, last worn, pairings or the calendar's monthly tally. Used for e.g. a shirt kept on overnight, so it isn't penalised in the rotation.
- **Planned outfits** are entries with `planned: true`, made by logging on a future date. They never count as wears, fits, pairings or exports until marked "Wore it" (which drops the flag). The Log screen flags past plans that weren't confirmed. For a future date, `statusOn()` counts earlier plans so a plan can't break a wear limit.
- **Type groups:** types with the same `group` share one calendar view and fill the same outfit slot, but stay separate types for data. Ungrouped types stand alone.
- **Estimated past wears (`estWears`)** add to total wears, and to cost per wear when the setting is on. They must never affect tracked history, the "worn in past X days" count, wear limits or the calendar.
- **Cost per wear** uses the purchase price (what was paid). Full price is only for reference. Before schema 6 the fields were list price + `discountPrice` (paid); `fixPrices()` converts old items, backups and CSVs (`discount_price` column).
- **Wear limit:** after N tracked wears the item rests for M months (calendar months from the last counted wear), then a new cycle starts. `rotation()` recalculates this from the log every time, so editing history stays consistent. Wears logged during a rest still count toward totals but not toward the cycle. A per-item limit overrides the type's limit.
- **Fit** has 5 levels: too-tight, snug, good, loose, too-loose, scored -2 to 2. Each item records a fit per wear (`entry.fits`) and per try-on (`item.tryOns`). Try-ons do not count as wears. The trend (recent vs earlier fits) matters.
- **Location:** where an item is kept. The "Dressing at" choice on the Log screen filters the item picker to that place. Every "Kept at" menu has "＋ New place…" to add one on the spot.
- **Size:** a new item gets its type's default size (tees default to XL), or else the size used most for that type. A "Men's"/"Women's" prefix is dropped (`cleanSize`).
- **Brands:** an item can have several (a collab, or a print brand on a blank like Comfort Colors), entered as chips that keep their spelling; the first is the main one. Shown joined with " / ". Old data had one `brand` string; schema 4 moved it to `brands[]`, and `brandsOf(i)` reads either. `brand` in the items CSV holds them separated by `;`.
- **Materials** are entered as chips like tags, with common materials suggested.
- **Made in:** one or more countries per item (e.g. assembled in one country from another's parts), entered as chips, suggested from countries already used plus a short list of common ones. Schema 5 moved the old single string to `madeIn[]`; `madeOf(i)` reads either. Searchable; `made_in` in the items CSV, separated by `;`.
- **Photo import** (Setup → Photos) matches image files by item name or by the ID at the end of the item's `link`, or reads a photo pack `{app:'rotation-photos', photos:[{link?, name?, data}]}`. Existing photos are kept unless "Replace" is ticked.
- **Tags** are entered as chips. Known tags (on items, plus `tagLibrary`) are suggested as you type, including close spellings, and an unknown tag is marked "new" so typos stand out.
- **Retired** means gone for good and is set by hand. **Resting** is temporary and comes from the wear limit.
- **The item picker** hides resting and retired items by default. It sorts by longest since worn unless another sort is picked (`PICK_SORTS`: closest to resting = fewest wears left in the cycle, recently worn, most worn, shuffle; remembered in `settings.pickSort`). Its place menu is the same setting as Log's "Dressing at" (`settings.logLocation`). Each card has "Not now", which sends the item to the end of the picker for a week (`item.snooze`, a date; tap again to undo).
- **Laundry check** (button at the top of Closet, `openLaundry`): a lookup for clothes coming out of the wash. With no search it lists what was worn in the last two weeks; search covers every item, resting and retired too. Each row says "Pack it" (resting, until when), "Drawer" (with wears left in the cycle) or "Retired", and has the item's Kept at menu so a packed item's place can be changed on the spot.
- **Auto-fill:**
  - Type is guessed from words in the name.
  - Colours are found by sampling the photo (`detectColours`): the background is the median shade of the border, and everything connected to the border that's close to it (shadows, gradients) is removed before counting; if almost nothing is left, the item is the background's colour. Setup → Photos → "Remove background white" re-checks items with photos and takes "white" off where the photo shows it's only the background (the old app tagged white on white-background photos).
  - Typing a name suggests matches from imported purchases.
  - Pasting a product link ("Store link" at the top of the editor) fills empty fields from the URL alone via `parseStoreLink`: store from the domain, name from the slug, trailing colour words as colours, brand if it matches one in the closet (or the first word on shoe stores like Zappos), and Shoes as the type on shoe stores. The app can't read store pages (browsers block cross-site reads), so no photo or price; an iOS Share-sheet Shortcut that fetches the page is the planned next step.
  - Store, size and made in suggest values as you type (`suggestField`: tappable chips under the box, close spellings included, most used when empty). Colours, tags and materials are chip fields (`tagField`).
  - **Read screenshots** (editor): pick one or more screenshots of a store page or receipt (several for a long page; they're read in order as one text). Text is read on the device (`OCR`), then `parseShotText` pulls out prices, size, colours ("Color: …", colour codes like "09 Black" handled), order date, store and brand (matched against known ones), and name ideas. A receipt line "Name $19.90" keeps its price and the size/colour on the next lines, so tapping that item fills all of them. Only empty or default fields are filled automatically; taps replace. Any screenshot can be cropped into the item photo. After the main read, each price is read again close up (`OCR.recheckPrices`: enlarged, digits only), because a small raised "$" can swallow the next digit ("$179.95" read as "$79.95"); the close-up is used only when it's the same price with digits added in front. "Show what it read" shows the raw text for troubleshooting.
  - There's no online AI. That's deliberate, to keep the app offline.

## Google Drive backup
- Uses Google Identity Services with a token client and scope `drive.file`, so the app only sees files it creates. The owner provides the OAuth client ID in Setup, and the authorised origin is `https://oreyes170.github.io`.
- On an iPhone home-screen app (`navigator.standalone`), Google's popup doesn't work, so `Drive.signIn(after)` redirects to Google and back to `https://oreyes170.github.io/rotation/`, which must be an authorised redirect URI. `Drive.fromRedirect()` picks the token out of the address on load (checking `state`), returns to the tab the sign-in started from, and finishes the connect, backup or restore.
- The backup is one file, `rotation-backup.json`. Auto-backup runs 4 seconds after a change, but only while a token is still valid.
- **This has not been tested against a real Google account yet.**

## CSV
- **Items:** import and export. Matching is by `id`, then `link`, then name plus type. A `total_wears` column (optionally with `as_of`) sets `estWears` to whatever counted wears up to that date don't cover, for totals known from elsewhere; since export writes total = tracked + estimate, a plain round trip leaves estimates unchanged. A row with no name only updates the item it matches by `id` or `link`, and only the columns it has. Unknown types and locations are created automatically. Tags and colours are separated with `;`.
- **Wear log:** import and export, with fit included. Rows match an item by `item_id`, name, or `link`; `not_counted` (yes) marks a day that isn't a wear. Imports add to the existing history; a wear already logged for that item and day is skipped. An optional checkbox takes imported wears off `estWears`, for wears that were already counted as estimates.
- **Purchases:** import only, for auto-fill. Columns are `date, retailer, item, size, color, price`.
- **Keep the owner's data files out of this public repo.** That includes exports from other wardrobe apps and purchase history.

## Open ideas, not built
1. **Photo import from a previous wardrobe app:** the image URLs are on Google Cloud Storage. Plan: collect the URLs from the old app's web page, build a photo pack outside the repo, and import it in Setup → Photos.
2. **Photos as separate files in a Drive folder** ("Rotation photos"), so the backup JSON stays small. Right now photos sit inside the backup, which gets big (about 200 photos ≈ 15–20 MB).
3. **Merging when both phone and computer have changes.** Today a restore replaces everything on the device, with no merge.
4. **A real iPhone app.** The owner is keeping the web app while testing and tweaking. When the owner is ready, the plan is:
   - Wrap the existing files with Capacitor and install the app on the owner's phone through TestFlight, not the App Store. That needs the Apple Developer Program ($99/year).
   - Build on a Mac with Xcode, or in the cloud with a GitHub Actions macOS runner or Codemagic.
   - Google Identity Services sign-in doesn't work inside the app's web view, so the Drive backup needs a native Google sign-in plugin, or a switch to iCloud.
   - The service worker isn't needed inside the app, and app storage isn't cleared by iOS.
   - Until then, keep the app static with no build step, and keep the Drive and sign-in code in one place so it's easy to swap out.

## Testing
- There are no automated tests in the repo. Test with Playwright against a local server: `python3 -m http.server`, then load the page and drive the UI.
- Check: adding items, logging outfits, wear limit and rest, combinations, fit, location filtering, calendar modes, CSV round trips, offline reload, 400px with no horizontal scroll, and dark mode.
