# 🌳 FTM_rec – Family Tree Data

A family tree data-input app for people and marriages. 2–3 family members can add, edit and delete records together, using a shared **family PIN** instead of accounts. The exported CSV/JSON feeds the next build, a family tree visualiser.

## How it runs
| Where it's opened | Mode | Data saved in |
|---|---|---|
| Cloudflare Worker (`ftm-rec`) | **Shared · online** | Cloudflare D1 database `ftm-rec` |
| GitHub Pages / local file / Claude artifact | Local only | That browser (localStorage) |

The page switches mode on its own: if `/api/ping` answers, it runs shared and online.

## Deploy (one time)
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick `FTM_rec`. Leave the build settings as they are; `wrangler.jsonc` already binds the D1 database `ftm-rec`.
2. Worker **ftm-rec → Settings → Variables and Secrets → Add → Secret**: name `FTM_PIN`, value = your family PIN (use 8+ characters). Deploy.
3. Open `https://ftm-rec.<your-subdomain>.workers.dev`, enter your name and the PIN, then share the link and PIN with the other editors.

The D1 tables (`people`, `marriages`, `audit_log`) are already created. To recreate them, run `schema.sql`.

## Features
- Add, edit and delete **people** and **marriages**. IDs are given out by the server, so two people adding at once never clash:
  `F0001` family line (blue) · `S0001` spouse who married in (orange) · `M0001` marriage
- **Edit-conflict protection**: if someone else saved the same record while you were editing, your save stops and the latest data reloads
- **Activity log**: who added, edited or deleted what, and when
- Changes from others appear every 30 s, and whenever you switch back to the tab
- Generation fills in automatically; Data checks tab; export CSV/JSON; import CSV/JSON
- **🔒 Lock** button forgets the PIN on a shared device

## Security notes
- There is one shared PIN and no per-person accounts. The editor name is self-declared and only used in the log.
- The PIN is checked on the server with a constant-time compare. After 8 wrong PINs from an IP, that IP is locked out for 15 minutes (best effort, per Worker instance).
- The PIN is remembered in each editor's browser until they press Lock.
- To change the PIN, update the `FTM_PIN` secret. Everyone will be asked for the new one.
- For stronger protection, put the Worker behind **Cloudflare Access** (free for up to 50 users; email one-time code, no passwords).

## Data model
**People** – `FID, Name, AlsoKnownAs, Gender, Type (F/S), Generation, FatherFID, MotherFID, Relation, BirthOrder, BirthYear, DeathYear, Status, Notes` (+ `UpdatedBy, UpdatedAt`)
**Marriages** – `MID, PersonA, PersonB, MarriageNo, YearMarried, YearEnded, EndType, Concurrent, Notes` (+ `UpdatedBy, UpdatedAt`)

- Blank Father + Mother = Parent `0-0` → founder (Generation 1)
- Spouse 2a (remarried after divorce) → marriage 1 `EndType = Divorced`
- Spouse 2b (two wives at the same time) → `Concurrent = Y`

Built by MohamedR · v1.1 2026
