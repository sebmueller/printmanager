# PrintManager – KI-Arbeitskontext

## Projektziel

Lokale Flask-Web-App zur Verwaltung von 3D-Druckprojekten, Teilen, STL-Dateien, Druckwarteschlange und Filamentspulen. Nutzeroberfläche und serverseitige Validierungsfehler sind Deutsch/Englisch.

## Architektur

- Backend: `app.py`, Flask + SQLite (`sqlite3`), keine ORM.
- Frontend: `static/index.html`, Vanilla JavaScript ES-Module in `static/app.js`, Übersetzungen in `static/i18n.js`, CSS in `static/style.css`.
- STL-Vorschau: lokal eingebundene Three.js-Module unter `static/vendor/`; keine Laufzeit-CDN-Abhängigkeit.
- Daten: `data.db` und hochgeladene Dateien in `files/`; beide sind in `.gitignore` ausgeschlossen.
- Konfiguration: `PM_DB`, `PM_FILES`, `PM_PORT`; Standard-Port 5000. Server bindet auf `0.0.0.0` und hat keine Authentifizierung.

## Wichtige Fachlogik

- Teilstatus: `geplant`, `queue`, `gedruckt`, `montiert`.
- `copies` ist die geplante Menge; `copies_printed` ist der tatsächlich gedruckte Teilfortschritt.
- `POST /api/parts/<id>/print` erhöht `copies_printed`; unvollständige Teile bleiben in `queue`, vollständige wechseln zu `gedruckt`.
- `spool_booked_g` ist die Filamentmenge, die diesem Teil bereits belastet wurde. Zielbuchung ist `filament_g * copies_printed`, falls eine Spule gewählt ist. Änderungen müssen alte Buchung erstatten und neue Buchung anwenden.
- Projekt-/Dashboardfortschritt, offene Druckzeit und offenes Filament müssen `copies_printed` berücksichtigen.
- Spulengruppe: `count` Spulen, `total_g` und `remaining_g` pro Spule. Verbrauch läuft spulenweise.
- Manuelles Setzen des Status auf `gedruckt`/`montiert` markiert alle Kopien als gedruckt. Zurücksetzen eines vollständig gedruckten Teils auf einen offenen Status setzt Fortschritt und Buchung zurück.
- Import/Export: `EXPORT_VERSION = 2`; ZIP enthält `manifest.json` und `files/`. Alte Version-1-Exporte ohne `copies_printed` müssen beim Import weiter funktionieren. Beim Import wird der gespeicherte Spulenrest nicht erneut belastet; `spool_booked_g` wird aus dem importierten Fortschritt rekonstruiert.

## Datenbankänderungen

Schema und additive Migrationen sind in `init_db()` in `app.py`. Migrationen müssen idempotent und rückwärtsverträglich sein. Neue Spalten hier ergänzen und alte Daten sinnvoll initialisieren. Bei Status-/Mengenmigrationen besonders `copies_printed` und `spool_booked_g` konsistent halten.

## Übersetzungen

- Jede neue sichtbare UI-Zeichenkette in `static/i18n.js` in beiden Blöcken (`de`, `en`) eintragen.
- Dynamische UI-Texte in `app.js` über `t(key, params)` erzeugen.
- Neue API-Validierungsfehler in der `ERRORS`-Map in `app.py` für Deutsch und Englisch ergänzen; der Client sendet `Accept-Language`.
- Sprache wird im Browser via `localStorage` gespeichert.

## Arbeitsweise und Verifikation

- Änderungen klein halten und bestehende Muster verwenden.
- Keine Kommentare in Code ergänzen, sofern der Nutzer nicht ausdrücklich darum bittet.
- Keine persönlichen Laufzeitdaten committen: `data.db`, `files/`, `server.log`, `__pycache__/` bleiben ausgeschlossen.
- Niemals Restore-, Lösch- oder Migrationstests gegen die echte `data.db` ausführen. Für Tests temporäre Pfade über `PM_DB` und `PM_FILES` setzen, bevor `app` importiert wird.
- Keine Commits oder Pushes ohne ausdrücklichen Nutzerauftrag.
- Es gibt kein dediziertes pytest/npm-Testsystem. Mindestens ausführen:
  - `python -m py_compile app.py`
  - `node --check` auf einer temporären `.mjs`-Kopie von `static/app.js` und `static/i18n.js`
  - gezielte Flask-Testclient-Tests mit temporärer Datenbank für Backendänderungen.
- Server läuft als Flask-Entwicklungsserver auf `0.0.0.0`; keine Authentifizierung. Nicht ohne explizite Anforderung öffentlich exponieren.

## Nützliche Routen

Siehe `README.md` für die API-Tabelle. Kernrouten: `/api/projects`, `/api/parts`, `/api/parts/<id>/print`, `/api/spools`, `/api/stats`, `/api/export/full`, `/api/import`.
