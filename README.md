# PrintManager

Lokale Web-App zur Verwaltung von 3D-Druckprojekten, Teilen, STL-Dateien, Druckwarteschlange und Filamentbestand. Die Oberfläche ist auf Deutsch und Englisch verfügbar.

## Funktionen

- Projekte mit Beschreibung, Notiz und URL verwalten
- Teile projektübergreifend verwalten: Status, Priorität, Kopien, Druckzeit, Filament und Spule
- Teilelisten nach Projekt gruppieren; Felder direkt in der Tabelle bearbeiten
- STL per Drag-and-drop oder im Teile-Dialog hochladen, interaktiv in 3D ansehen und wieder herunterladen
- STL-Uploads einem vorhandenen oder neu angelegten Projekt zuordnen und dabei die Spule auswählen
- Warteschlange sortieren und die tatsächlich gedruckte Kopienzahl erfassen; Teilfortschritt und Filamentbuchung werden berücksichtigt
- Spulen nach Material und Farbe verwalten, einschließlich Anzahl und Restbestand
- Einzelprojekte oder alle Daten einschließlich STL-Dateien als ZIP exportieren und importieren
- Import-Export-Format mit Versionsnummer; aktuelle Version 2, ältere Version 1 wird weiter eingelesen

## Voraussetzungen

- Python 3.13 empfohlen (Python 3.10 oder neuer sollte funktionieren)
- Flask 3.1
- Aktueller Browser mit WebGL-Unterstützung für die STL-Vorschau

Node.js wird zur Laufzeit nicht benötigt. Three.js, STLLoader und OrbitControls sind lokal unter `static/vendor/` eingebunden; für die Vorschau ist keine CDN-Verbindung nötig.

## Installation und Start unter Windows

Im Projektverzeichnis PowerShell öffnen:

```powershell
python -m pip install Flask==3.1.0
python app.py
```

Anschließend im Browser öffnen:

- Auf demselben Rechner: `http://localhost:5000`
- Im lokalen Netz: `http://<IP-des-Rechners>:5000`
- Über Tailscale: `http://<Tailscale-IP>:5000`

Der Server bindet standardmäßig an `0.0.0.0`, damit andere Geräte ihn erreichen können. Es gibt **keine Anmeldung, HTTPS- oder Berechtigungsprüfung**. Nur in vertrauenswürdigen Netzwerken bzw. über eine entsprechend abgesicherte Tailscale-Konfiguration verwenden; Port 5000 nicht ungeschützt ins Internet freigeben.

Mit `Ctrl+C` wird der Server im Vordergrund beendet.

## Daten und Konfiguration

Standardmäßig liegen die Laufzeitdaten im Projektverzeichnis:

- `data.db` – SQLite-Datenbank
- `files/` – hochgeladene Originaldateien
- `server.log` – optionales Server-Log, falls beim Start eine Umleitung eingerichtet ist

Diese Dateien sind in `.gitignore` ausgeschlossen und gehören nicht ins Git-Repository.

Folgende Umgebungsvariablen können vor dem Start gesetzt werden:

| Variable | Standard | Zweck |
| --- | --- | --- |
| `PM_DB` | `data.db` im Projektordner | Pfad zur SQLite-Datenbank |
| `PM_FILES` | `files/` im Projektordner | Ordner für hochgeladene Dateien |
| `PM_PORT` | `5000` | HTTP-Port |

Der übergeordnete Ordner für `PM_DB` muss existieren; der Dateiordner `PM_FILES` wird beim Start angelegt, wenn sein übergeordneter Ordner existiert. Beide Pfade müssen beschreibbar sein. Beispiel in PowerShell:

```powershell
$env:PM_PORT = "5001"
python app.py
```

Die Datenbank wird beim Programmstart angelegt bzw. mit den erforderlichen Spalten erweitert. Vor Datenbankänderungen oder Wiederherstellungen empfiehlt sich ein Export über **Dashboard → Backup (alles)**.

## Bedienung

### Projekte und Teile

Auf dem Dashboard ein Projekt öffnen, um dessen Teile zu sehen und zu bearbeiten. Im Reiter **Teile** sind alle Teile projektweise gruppiert. Name, Kopien, Druckstatus, Druckzeit pro Kopie, Filament pro Kopie, Spule und Priorität lassen sich direkt in den Tabellen bearbeiten. Änderungen werden beim Verlassen des Feldes gespeichert.

Projektfelder:

- Name
- Beschreibung
- Notiz (mehrzeilig)
- URL (wird in der Projektansicht als Link angezeigt)

### STL-Dateien

STL-Dateien lassen sich auf das Browserfenster ziehen oder über **+ Teil** im Teil-Dialog auswählen. Beim Upload kann ein Projekt angelegt bzw. ausgewählt werden; in der Projektansicht ist das aktuelle Projekt vorausgewählt. Spule und Kopien lassen sich ebenfalls dort auswählen.

Die Vorschau ist interaktiv. Sie wird im Browser aus der gespeicherten STL erzeugt; ein separates Vorschaubild wird nicht gespeichert. Der Datei-Download liefert die Originaldatei zurück. Upload und Vorschau unterstützen STL; 3MF-Dateien können über lokale Pfade/Links referenziert werden, werden aber nicht über den Upload-Dialog angenommen.

### Warteschlange und Teilfortschritt

Statuswerte: **Geplant**, **In Queue**, **Gedruckt**, **Montiert**. In der Warteschlange die Anzahl der bei diesem Drucklauf fertiggestellten Kopien eintragen und **Druck erfassen** wählen. Bei einem Teildruck bleibt das Teil mit Fortschritt in der Warteschlange. Nach der letzten Kopie wechselt es automatisch auf **Gedruckt**.

Die Statusauswahl in einer Teile-Tabelle ist eine manuelle Gesamtstatus-Änderung: „Gedruckt“ bzw. „Montiert“ markiert alle Kopien als gedruckt. Wird ein vollständig gedrucktes Teil auf „Geplant“ oder „In Queue“ zurückgesetzt, wird der erfasste Druckfortschritt aufgehoben und die Filamentbuchung zurückgenommen.

### Filament und Spulen

Ein Teil kann einer Spulengruppe zugeordnet werden. Verbrauch wird erst beim Erfassen gedruckter Kopien gebucht: `Filament pro Kopie × gedruckte Kopien`. Teilweise gedruckte Aufträge buchen entsprechend nur den Teilverbrauch. Beim Zurücksetzen oder Löschen eines gebuchten Teils wird die Buchung zurückgegeben.

Die Anzahl in einer Spulengruppe bezeichnet gleichartige Spulen. Rest- und Gesamtgewicht werden pro Spule geführt und in der Übersicht mit der Anzahl multipliziert. Die Verbrauchslogik leert eine Spule nach der anderen.

### Import und Export

- **Projektansicht → Export** exportiert ein Projekt, seine Teile, zugehörige Spulen und Dateien.
- **Dashboard → Backup (alles)** exportiert alle Projekte, Spulen und STL-Dateien.
- **Dashboard → Import → Anhängen** importiert als zusätzliche Projekte und Spulen; vorhandene Daten bleiben bestehen.
- **Dashboard → Import → Überschreiben** löscht alle vorhandenen Projekte, Teile und Spulen vor dem Wiederherstellen. Nur nach vorherigem Backup verwenden.

ZIP-Archive enthalten `manifest.json` mit Formatkennung und Version sowie referenzierte Dateien. Der Import weist Exporte mit einer höheren, nicht unterstützten Formatversion zurück.

## API-Übersicht

Die JSON-API wird vom Flask-Server bereitgestellt. Änderungsrouten erwarten JSON, sofern nicht Datei-Upload angegeben ist.

| Methode | Route | Zweck |
| --- | --- | --- |
| `GET` | `/api/projects` | Projekte samt Fortschritt und Summen |
| `POST` | `/api/projects` | Projekt anlegen |
| `GET` | `/api/projects/<id>` | Einzelnes Projekt |
| `PUT` | `/api/projects/<id>` | Projekt aktualisieren |
| `DELETE` | `/api/projects/<id>` | Projekt und zugehörige Dateien löschen |
| `GET` | `/api/parts?project_id=<id>&status=<status>` | Teile auflisten; Filter optional |
| `POST` | `/api/parts` | Teil anlegen; JSON oder Multipart mit `file` |
| `GET` | `/api/parts/<id>` | Einzelnes Teil |
| `PUT` | `/api/parts/<id>` | Teilfelder bzw. Status aktualisieren |
| `POST` | `/api/parts/<id>/print` | Gedruckte Kopien erfassen (`{"copies": n}`) |
| `DELETE` | `/api/parts/<id>` | Teil löschen und gebuchtes Filament zurückgeben |
| `POST` | `/api/parts/<id>/file` | STL-Datei ersetzen (Multipart) |
| `GET` | `/api/parts/<id>/file` | Originaldatei herunterladen |
| `POST` | `/api/parts/<id>/open-explorer` | Quelldatei im Explorer zeigen (Windows-Server) |
| `POST` | `/api/queue/reorder` | Queue-Reihenfolge aktualisieren (`{"ids": [...]}`) |
| `GET`, `POST` | `/api/spools` | Spulen auflisten/anlegen |
| `PUT`, `DELETE` | `/api/spools/<id>` | Spule aktualisieren/löschen |
| `POST` | `/api/spools/<id>/refill` | Spule nachfüllen (`{"amount_g": n}`) |
| `GET` | `/api/stats` | Dashboard-Statistiken |
| `GET` | `/api/export/project/<id>` | Projekt-ZIP herunterladen |
| `GET` | `/api/export/full` | Komplett-Backup herunterladen |
| `POST` | `/api/import` | ZIP importieren; Multipart-Felder `file`, `mode` (`merge`/`restore`) |

Die API-Fehlermeldungen verwenden den `Accept-Language`-Header (`de`/`en`).

## Entwicklung und Tests

Es gibt derzeit kein separates Test- oder Build-System. Syntaxprüfungen:

```powershell
python -m py_compile app.py
Copy-Item static\app.js $env:TEMP\appcheck.mjs
node --check $env:TEMP\appcheck.mjs
```

Backend-Tests sollten den Flask-Testclient mit einer temporären SQLite-Datenbank (`PM_DB`) und einem temporären Dateiordner (`PM_FILES`) verwenden. Niemals Restore-Import-, Lösch- oder Migrationstests direkt gegen die persönliche `data.db` ausführen.

## Projektstruktur

```text
app.py                         Flask-API, SQLite, Upload, Migration, Import/Export
static/index.html              Grundgerüst und Dialoge
static/app.js                  UI, Ereignisse, Tabellen und STL-Viewer
static/i18n.js                 Deutsch-/Englisch-Übersetzungen
static/style.css               Darstellung
static/vendor/                 Lokal eingebundene Three.js-Module
files/                         Laufzeitdateien; nicht versioniert
data.db                        Laufzeitdatenbank; nicht versioniert
```
