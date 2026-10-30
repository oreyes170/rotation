# Rotation

A personal wardrobe and wear tracker. Works offline, keeps data on your device, and backs up to your own Google Drive.

## Put it online (GitHub Pages)
1. Create a new public GitHub repository (e.g. `rotation`) and upload every file in this folder.
2. In the repo: Settings → Pages → Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`. Save.
3. After a minute it's live at `https://<your-username>.github.io/rotation/`.
4. On your phone, open that address and use "Add to Home Screen". It then opens like an app and works offline.

## Turn on Google Drive backup (one time)
1. console.cloud.google.com → create a project → enable the **Google Drive API**.
2. OAuth consent screen → External → add yourself as a test user.
3. Credentials → Create OAuth client ID → Web application → Authorised JavaScript origins: `https://<your-username>.github.io`
4. In Rotation → Setup → paste the client ID → Connect Google Drive.

Backups go to one file, `rotation-backup.json`, in your Drive. To use the same closet on your computer, open the same address there, connect Drive, and tap "Restore from Drive". Restoring replaces what's on that device.

## Spreadsheets (CSV)
Setup → Spreadsheet (CSV) exports your items (with wear counts and cost per wear) and your wear log, and imports both. Download the blank items template to see the columns. Importing items updates matching items instead of duplicating them; importing a wear log adds to your history, so import each file once.

## Your own data files
Keep your own spreadsheets (purchase history, exports from other apps) out of the GitHub repo, because a public repo is visible to anyone. Import them from Setup on your device instead.
