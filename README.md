# FFW Anwesenheit — Open-Source-Template

Mobile Web-App (iOS-first / PWA) zur Dokumentation der Anwesenheit bei
Ausbildungsabenden / Übungen der Freiwilligen Feuerwehr.

Diese Version ist eine **anonymisierte Template-Variante** der produktiven
App der FF Musterwehr. Sie wird automatisch aus dem produktiven Repo
synchronisiert — Updates am Hauptprojekt landen also auch hier.

> Wenn du diese App für deine Wehr einsetzen möchtest: das Repo forken oder
> klonen, die wenigen Stellen mit eigenen Daten ersetzen, deployen.

## Features

- Mobile-first PWA, installierbar auf iPhone- und Android-Homescreens
- Anwesenheits-Erfassung mit konfigurierbaren Tags (Atemschutz, Führerscheinkontrolle, …)
- Rollensystem: Admin (Vollzugriff) und Erfasser (eigene Anwesenheiten)
- Verlauf vergangener Übungen, Excel-Export
- Benutzerverwaltung im Frontend
- Versand der Anwesenheitsliste per E-Mail (mailto-Link)

## Stack

- Frontend: Vanilla JS + CSS (kein Build-Step)
- Backend: Cloudflare Pages Functions (Edge Runtime)
- Datenbank: Cloudflare D1 (SQLite)
- Auth: HttpOnly-Session-Cookie, PBKDF2-SHA256 Passwort-Hashing

## Schnellstart für deine Wehr

### 1. Repo klonen / forken
```
git clone https://github.com/andreaseufinger/ffw-anwesenheit.git ffw-meine-wehr
cd ffw-meine-wehr
npm install
```

### 2. Personen anlegen
Deine eigene Mitgliederliste in **drei** Dateien hinterlegen (gleiches Format):
- `Personen.csv` — Quelldatei zur Übersicht (Nachname,Vorname)
- `public/data/personen.json` — vom Build-Skript der App genutzt
- `functions/_data/personen.json` — von der API genutzt (eingebettet)

### 3. Themen anpassen (optional)
`public/data/themen.json` enthält ca. 80 Standardthemen
(FwDV, Übungen, Versammlungen …). Anpassen, ergänzen, kürzen wie nötig.

### 4. Cloudflare-Setup
```
# D1-Datenbank anlegen (Name frei wählbar, hier: "anwesenheit")
npx wrangler d1 create anwesenheit

# Schema lokal und remote ausrollen
npx wrangler d1 execute anwesenheit --local  --file=./schema.sql
npx wrangler d1 execute anwesenheit --remote --file=./schema.sql
```

Das D1-Binding wird NICHT in `wrangler.toml` hinterlegt, sondern
ausschließlich im Cloudflare-Pages-Dashboard (siehe Schritt 6).

### 5. Lokal entwickeln
```
npm run dev
# http://localhost:8788
```

Standard-Login:
- Benutzer: `Admin`
- Passwort: `changeme`

**WICHTIG:** Nach dem ersten Login sofort das Passwort ändern (Menü →
Benutzer verwalten).

### 6. Deployment via Cloudflare Pages
1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Repo auswählen, Branch `main`
3. Build settings:
   - Build command: *(leer)*
   - **Build output directory: `public`**
   - Root directory: *(leer)*
4. Nach erstem Deploy: Settings → Functions → D1 database bindings → Add:
   - **Variable name: `DB`**
   - D1 database: deine eben angelegte Datenbank
5. Retry Deployment triggern, damit das Binding aktiv wird

**Warum kein `wrangler.toml`?** Cloudflare Pages verriegelt Dashboard-
Bindings, sobald eine `wrangler.toml` im Repo liegt. Weil wir im Template
deine `database_id` nicht kennen, halten wir das Repo config-frei und du
setzt alles einmal im Dashboard.

Jeder Push auf `main` deployed danach automatisch.

## Rollen

Die App unterstützt vier Rollen (zwei davon für die Anwesenheits-App relevant):

- `admin_anwesenheit` — Vollzugriff, Benutzerverwaltung, Excel-Export, Tags
- `erfasser_anwesenheit` — Anwesenheiten erfassen + eigene einsehen/bearbeiten

Die `*_einsatzprotokoll`-Rollen existieren im Schema, werden in dieser
Variante aber nicht verwendet. Lass sie drin, falls du später eine
Einsatzprotokoll-App auf derselben D1 betreibst.

## Lizenz

MIT — siehe `LICENSE`. Nutze die App frei für deine Wehr.

## Mitwirken

Diese Repository ist ein automatischer Spiegel des produktiven Quell-Repos
der FF Musterwehr. Issues und PRs sind willkommen — die Maintainer übertragen
sie ggf. ins Quell-Repo.
