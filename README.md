# HomeFinder

A small, static rental-search dashboard. Track Zillow listings in a sortable table, see them on a map, and capture new ones in one click with a bookmarklet. Data lives as a JSON file in this repo and syncs via the GitHub Contents API — no backend.

## What's in it

- **Table view** — sortable columns, status filter (interested / visited / applied / favorited / rejected), free-text search across address/notes/tags
- **Map view** — Leaflet + OpenStreetMap, pins colored by status, click to open
- **Add via bookmarklet** — one click on any Zillow listing page sends the listing to a pre-filled form
- **Edit / delete / rate / tag / annotate** any listing
- **GitHub sync** — listings stored as `data/listings.json` in this repo, auto-pushed on every change
- **Export / Import** JSON for backups or one-off transfers

## Setup

### 1. Deploy to GitHub Pages

After pushing this repo to GitHub:

1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**, Branch: `main`, Folder: `/ (root)`
3. Save. Your dashboard lives at `https://<your-username>.github.io/<repo-name>/`

### 2. Create a fine-grained Personal Access Token

The dashboard writes `data/listings.json` directly via the GitHub API.

1. Open <https://github.com/settings/personal-access-tokens/new>
2. **Resource owner:** your account
3. **Repository access:** Only select repositories → choose this repo
4. **Permissions → Repository permissions → Contents:** Read and write
5. Generate and copy the token (`github_pat_...`)

> The token is stored only in your browser's localStorage. Anyone with access to your browser profile can read it — use a token scoped to this single repo, and revoke it if you suspect compromise.

### 3. Configure the dashboard

Open the dashboard → **Settings** tab → fill in owner, repo, branch (`main`), and paste the PAT → **Save & test**.

### 4. Install the bookmarklet

Open **Settings → Bookmarklet → Set up bookmarklet →** drag the blue button onto your bookmarks bar.

(Press `Ctrl+Shift+B` in your browser if the bookmarks bar is hidden.)

## Daily use

- On any Zillow listing page, click the **+ Add to HomeFinder** bookmark. A new tab opens with the listing data pre-filled — review and Save.
- Click any row in the table to edit. Click any pin on the map to see a summary and jump to edit.
- Changes auto-push to GitHub. The sync badge in the header turns green when synced.

## Data schema

Each listing in `data/listings.json` looks like:

```json
{
  "id": "abc123xyz",
  "url": "https://www.zillow.com/...",
  "zpid": "12345678",
  "address": "1234 Main St",
  "city": "Portland",
  "state": "OR",
  "zip": "97201",
  "lat": 45.5234,
  "lng": -122.6762,
  "price": 2400,
  "beds": 2,
  "baths": 1.5,
  "sqft": 950,
  "pricePerSqft": 2.53,
  "homeType": "Apartment",
  "petPolicy": "Cats ok, no dogs",
  "parking": "1 off-street",
  "laundry": "In-unit",
  "availableDate": "2026-06-15",
  "status": "interested",
  "rating": 4,
  "tags": ["quiet street", "near transit"],
  "notes": "Tour scheduled Saturday",
  "photoUrl": "https://...",
  "addedAt": "2026-05-25T17:32:00.000Z",
  "updatedAt": "2026-05-25T17:32:00.000Z"
}
```

`pricePerSqft` is computed automatically. The `id` is generated locally. All other fields are optional.

## Files

| File | Purpose |
|---|---|
| `index.html` | Dashboard markup |
| `app.js` | All dashboard logic (state, render, GitHub sync) |
| `styles.css` | Styling (light + dark, follows OS preference) |
| `bookmarklet.html` | Generates a bookmarklet tied to your dashboard URL |
| `data/listings.json` | Your listings, committed to the repo |

## Troubleshooting

**Settings → Save & test says "404"**
Either the repo name is wrong or the PAT doesn't have access. Double-check that the PAT's *Repository access* includes this exact repo.

**Bookmarklet opens the dashboard but the form is mostly empty**
Zillow's page structure varies by listing type (for-sale vs. rental vs. multi-unit building). The bookmarklet pulls from JSON-LD, `__NEXT_DATA__`, and meta tags — any of which Zillow can change. Fill in what's missing manually; future improvements can extend the extractor.

**The map is empty even though I have listings**
The map only shows listings with latitude/longitude. The bookmarklet sets these when Zillow exposes them. For manual entries, you can grab coordinates by right-clicking the address in Google Maps.

**I lost my PAT**
Generate a new one and update Settings. The old PAT can be revoked from GitHub settings without affecting your data.
