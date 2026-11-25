# 🌳 Family Tree Data – FTM

A one-page input app for collecting family tree data: people and marriages. The exported CSV/JSON feeds the next build, a family tree visualiser.

Open `index.html` in a browser, or host it on GitHub Pages or Cloudflare Workers. No install or server needed.

## Features
- Add, edit and delete **people** and **marriages**
- Auto IDs: `F0001` = family line (blue), `S0001` = spouse who married in (orange), `M0001` = marriage
- Generation is filled in for you: parent + 1, founders (no parents, 0-0) = 1, and spouses take their partner's generation
- Data checks: missing parents, born before a parent, overlapping marriages not marked concurrent, wrong generation, and more
- Export `people.csv` + `marriages.csv` (Excel friendly), or JSON
- Import CSV/JSON to restore or merge
- Search, sort by column, filter by generation

> Data is saved only in the browser (localStorage). Export CSVs regularly as a backup.

## Data model

**People** – `FID, Name, AlsoKnownAs, Gender, Type (F/S), Generation, FatherFID, MotherFID, Relation, BirthOrder, BirthYear, DeathYear, Status, Notes`

- Blank Father + Mother = Parent `0-0` → founder
- Status: Living / Deceased / Unknown (a blank death year means "not known")
- BirthOrder is used to arrange siblings later

**Marriages** – `MID, PersonA, PersonB, MarriageNo, YearMarried, YearEnded, EndType, Concurrent, Notes`

- Spouse 2a (remarried after divorce) → marriage 1 has `EndType = Divorced`
- Spouse 2b (two wives at the same time) → `Concurrent = Y`
- "Not married" = the person has no marriage rows

Built by MohamedR · v1.0 2026
