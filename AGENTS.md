# PrintManager – KI-Arbeitskontext

## Projektziel

Lokale Flask-Web-App zur Verwaltung von 3D-Druckprojekten, Teilen, STL-Dateien, Druckwarteschlange und Filamentspulen. Nutzeroberfläche und serverseitige Validierungsfehler sind Deutsch/Englisch.

## Architektur

- Backend: `app.py`, Flask + SQLite (`sqlite3`), keine ORM.
- Frontend: `static/index.html`, Vanilla JavaScript ES-Module in `static/app.js`, Übersetzungen in `static/i18n.js`, CSS in `static/style.css`.
- STL-Vorschau: lokal eingebundene Three.js-Module unter `static/vendor/`; keine Laufzeit-CDN-Abhängigkeit.
- Daten: `data.db` und hochgeladene Dateien in `files/`; beide sind in `.gitignore` ausgeschlossen.
- Einstellungen: `settings.json` (Slicer-Pfad), konfigurierbar über `PM_SETTINGS`; ebenfalls nicht versioniert.
- Konfiguration: `PM_DB`, `PM_FILES`, `PM_SETTINGS`, `PM_PORT`; Standard-Port 5000. Server bindet auf `0.0.0.0` und hat keine Authentifizierung.

## Wichtige Fachlogik

- Teilstatus: `geplant`, `queue`, `gedruckt`, `montiert`.
- `copies` ist die geplante Menge pro Satz; `copies_printed` ist der tatsächlich gedruckte Teilfortschritt.
- Projekte haben `runs` (Durchläufe/Sätze). Der Gesamtbedarf eines Teils ist `copies × runs`; Status-, Queue-, Statistik-, Fortschritts- und Buchungslogik müssen diese Menge verwenden. Änderungen an `runs` normalisieren die Status der Teile (`normalize_project_parts`).
- Projekte haben `archived` (0/1). `GET /api/projects` liefert standardmäßig nur aktive Projekte; `?archived=1` nur archivierte, `?include_archived=1` alle. Dashboard-Statistiken (`/api/stats`) schließen archivierte Projekte aus. Archivieren/Reaktivieren über `PUT /api/projects/<id>` mit `{"archived": 0|1}`.
- `POST /api/parts/<id>/print` erhöht `copies_printed`; unvollständige Teile bleiben in `queue`, vollständige wechseln zu `gedruckt`.
- `spool_booked_g` ist die tatsächlich von diesem Teil verbrauchte Filamentmenge (inklusive Ausschuss). Buchungen sind inkrementell: Drucken addiert `filament_g × Kopien`, Zurücknehmen mit `refund=false` lässt den Verbrauch stehen, mit `refund=true` wird `filament_g × Kopien` erstattet (maximal bis zur bisherigen Buchung). Beim Spulenwechsel wird die gebuchte Menge auf die neue Spule übertragen; ohne Spule wird sie auf 0 gesetzt. Nicht wieder auf `filament_g × copies_printed` zurückrechnen, sonst geht Ausschuss verloren.
- Projekt-/Dashboardfortschritt, offene Druckzeit und offenes Filament müssen `copies_printed` berücksichtigen.
- Spulengruppe: `count` Spulen, `total_g` und `remaining_g` pro Spule. Verbrauch läuft spulenweise.
- `GET /api/spools` liefert zusätzlich `planned_g` (offene Nachfrage nach Abzug von `copies_printed`), `available_g = remaining_g + max(count - 1, 0) * total_g` (nur die aktuelle Spule ist angebrochen) und `missing_g = max(planned_g - available_g, 0)`. Dashboard-Stats liefern `filament_unassigned_g` für Teile ohne Spule. Die Filamentansicht addiert offene Fehlmengen je Spule und weist unzugewiesenen Bedarf separat aus.
- Manuelles Setzen des Status auf `gedruckt`/`montiert` markiert alle Kopien als gedruckt. Zurücksetzen eines vollständig gedruckten Teils auf einen offenen Status setzt Fortschritt und Buchung zurück.
- Import/Export: `EXPORT_VERSION = 4`; ZIP enthält `manifest.json` und `files/`. Exporte der Versionen 1 bis 3 ohne `runs`/`copies_printed`/`archived` müssen beim Import weiter funktionieren (`runs` dann 1, `archived` 0). `spool_booked_g` wird exportiert und beim Import übernommen, damit Ausschuss erhalten bleibt; fehlt es in älteren Exporten, wird es aus dem Fortschritt rekonstruiert. Beim Import wird der gespeicherte Spulenrest nicht erneut belastet.
- Slicer-Start (`POST /api/parts/<id>/open-slicer`) kopiert die STL unter dem Originalnamen nach `%TEMP%\printmanager\` und startet das konfigurierte Programm mit Dateipfad als Argument, ohne Shell. Bei Anycubic/Orca/Bambu wird zusätzlich `--single-instance` übergeben, damit die Datei an die laufende Instanz geht. Slicer-Pfad kommt aus `settings.json`, sonst automatische Erkennung bekannter Anycubic-Pfade. Fehlt Programm oder Datei, klare 400/404-Fehler.
- Schätzwerte (`POST /api/parts/<id>/slice`) rufen dieselbe EXE headless auf: `--load-settings "<machine>;<process>" --load-filaments "<filament>" --orient 1 --slice 0 --outputdir <tmp> <stl>`. `--orient 1` ist wichtig, weil die Original-STLs oft beliebig positioniert sind. Danach wird `plate_1.gcode` im Temp-Ausgabeordner geparst (`estimated printing time (normal mode)`, `total filament used [g]`, Fallbacks) und `time_min`/`filament_g` des Teils (pro Kopie) aktualisiert. Profile kommen aus `settings.json.profiles` oder der Anfrage; Profilliste kommt aus `<slicer>/resources/profiles/*/{machine,process,filament}` und `%APPDATA%\AnycubicSlicerNext\user\*\{...}` (Backup-Ordner ausgeschlossen), siehe `GET /api/slicer/profiles`. Timeout `PM_SLICE_TIMEOUT` (Standard 300 s), Temp-Ordner werden aufgeräumt.
- Slicer-Start sowie Lesen/Schreiben der Slicer-Einstellungen und Slicing sind über `require_local()` auf Loopback-Adressen beschränkt. Diese Einschränkung nicht ohne ausdrückliche Anforderung lockern.

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
- Niemals Restore-, Lösch- oder Migrationstests gegen die echte `data.db` ausführen. Für Tests temporäre Pfade über `PM_DB`, `PM_FILES` und `PM_SETTINGS` setzen, bevor `app` importiert wird.
- Keine Commits oder Pushes ohne ausdrücklichen Nutzerauftrag.
- Es gibt kein dediziertes pytest/npm-Testsystem. Mindestens ausführen:
  - `python -m py_compile app.py`
  - `node --check` auf einer temporären `.mjs`-Kopie von `static/app.js` und `static/i18n.js`
  - gezielte Flask-Testclient-Tests mit temporärer Datenbank für Backendänderungen.
- Server läuft als Flask-Entwicklungsserver auf `0.0.0.0`; keine Authentifizierung. Nicht ohne explizite Anforderung öffentlich exponieren.

## Nützliche Routen

Siehe `README.md` für die API-Tabelle. Kernrouten: `/api/projects`, `/api/parts`, `/api/parts/<id>/print`, `/api/parts/<id>/unprint`, `/api/parts/<id>/open-slicer`, `/api/parts/<id>/slice`, `/api/slicer/profiles`, `/api/spools`, `/api/settings`, `/api/stats`, `/api/export/full`, `/api/import`.
