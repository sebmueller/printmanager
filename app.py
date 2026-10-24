import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PM_DB", str(BASE / "data.db")))
FILES_DIR = Path(os.environ.get("PM_FILES", str(BASE / "files")))
SETTINGS_PATH = Path(os.environ.get("PM_SETTINGS", str(BASE / "settings.json")))
FILES_DIR.mkdir(exist_ok=True)

STATUSES = ["geplant", "queue", "gedruckt", "montiert"]
STATUS_IDX = {s: i for i, s in enumerate(STATUSES)}
PRINTED_IDX = STATUS_IDX["gedruckt"]

ERRORS = {
    "name_required": ("Name fehlt", "Name is required"),
    "invalid_status": ("Ungültiger Status", "Invalid status"),
    "copies_min": ("Kopien müssen >= 1 sein", "Copies must be >= 1"),
    "copies_below_printed": ("Die Kopienanzahl kann nicht kleiner als die bereits gedruckte Anzahl sein.",
                             "Total copies cannot be less than the number already printed."),
    "print_count_invalid": ("Bitte eine gültige Anzahl größer als 0 eingeben.",
                             "Enter a valid quantity greater than 0."),
    "print_count_excess": ("Es sind nur noch {remaining} Kopien offen.",
                            "Only {remaining} copies are still outstanding."),
    "unprint_count_invalid": ("Bitte eine gültige Anzahl gedruckter Kopien angeben.",
                              "Enter a valid number of printed copies."),
    "unprint_count_excess": ("Es sind nur {printed} Kopien als gedruckt erfasst.",
                             "Only {printed} copies are recorded as printed."),
    "not_in_queue": ("Dieses Teil ist nicht in der Warteschlange.",
                     "This part is not in the queue."),
    "project_missing": ("Projekt existiert nicht", "Project does not exist"),
    "project_exists": ("Ein Projekt mit dem Namen \"{name}\" existiert bereits.",
                       "A project named \"{name}\" already exists."),
    "no_file": ("Keine Datei übergeben", "No file provided"),
    "path_missing": ("Pfad existiert nicht: {path}", "Path does not exist: {path}"),
    "bad_zip": ("Ungültige ZIP-Datei (manifest.json fehlt oder ist beschädigt)",
                "Invalid ZIP file (manifest.json missing or corrupt)"),
    "unknown_format": ("Unbekanntes Export-Format", "Unknown export format"),
    "newer_version": ("Export stammt von einer neueren Tool-Version",
                      "Export was created by a newer tool version"),
    "invalid_mode": ("Ungültiger Modus", "Invalid mode"),
    "no_zip": ("Keine ZIP-Datei übergeben", "No ZIP file provided"),
    "spool_booked": ("Spule ist mit gebuchten Teilen verknüpft",
                     "Spool is linked to printed parts"),
    "local_only": ("Diese Funktion ist nur am PC möglich, auf dem der PrintManager läuft.",
                   "This feature is only available on the computer running PrintManager."),
    "slicer_not_configured": ("Kein Slicer konfiguriert. Bitte in den Einstellungen hinterlegen.",
                              "No slicer configured. Please set it in the settings."),
    "slicer_invalid": ("Slicer-Programm nicht gefunden: {path}",
                        "Slicer executable not found: {path}"),
    "slicer_profile_missing": ("Bitte Drucker-, Prozess- und Filamentprofil auswählen.",
                               "Please select printer, process and filament profiles."),
    "slicer_profile_invalid": ("Profil nicht gefunden: {path}",
                                "Profile not found: {path}"),
    "slicer_slice_failed": ("Slicing fehlgeschlagen: {msg}",
                             "Slicing failed: {msg}"),
    "slicer_timeout": ("Slicing hat das Zeitlimit überschritten.",
                        "Slicing timed out."),
}


def terr(key, **kw):
    de, en = ERRORS[key]
    lang = request.accept_languages.best_match(["de", "en"]) or "de"
    return (en if lang == "en" else de).format(**kw)


LOCAL_ADDRS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def require_local():
    if (request.remote_addr or "") not in LOCAL_ADDRS:
        abort(403, terr("local_only"))


def load_settings():
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data):
    SETTINGS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def detect_slicer():
    bases = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"),
        os.environ.get("LOCALAPPDATA"),
    ]
    rel = [
        ("AnycubicSlicerNext", "AnycubicSlicerNext.exe"),
        ("AnycubicSlicer", "AnycubicSlicer.exe"),
    ]
    for base in bases:
        if not base:
            continue
        for folder, exe in rel:
            candidate = Path(base) / folder / exe
            if candidate.is_file():
                return str(candidate)
    return ""


PROFILE_KINDS = ("machine", "process", "filament")


def slicer_exe(settings=None):
    settings = settings if settings is not None else load_settings()
    exe = (settings.get("slicer_path") or "").strip() or detect_slicer()
    return exe if exe and Path(exe).is_file() else ""


def profile_roots():
    exe = slicer_exe()
    base = Path(exe).parent if exe else None
    system = base / "resources" / "profiles" if base else None
    user = Path(os.environ.get("APPDATA", "")) / "AnycubicSlicerNext" / "user"
    return system, user


def list_slicer_profiles():
    system, user = profile_roots()
    found = {k: {} for k in PROFILE_KINDS}
    for kind in PROFILE_KINDS:
        files = []
        if system and system.is_dir():
            files += [p for p in system.glob(f"*/{kind}/*.json")]
        if kind == "filament":
            if user and user.is_dir():
                files += [p for p in user.glob("*/filament/**/*.json")]
        elif user and user.is_dir():
            files += [p for p in user.glob(f"*/{kind}/*.json")]
        for path in files:
            if "backup" in str(path).lower():
                continue
            found[kind][str(path)] = path.stem
    return {kind: [{"name": name, "path": path}
                   for path, name in sorted(found[kind].items(), key=lambda kv: kv[1].lower())]
            for kind in PROFILE_KINDS}


def parse_duration(text):
    parts = re.findall(r"(\d+)\s*([dhms])", text or "")
    if not parts:
        return None
    factors = {"d": 1440, "h": 60, "m": 1, "s": 1 / 60}
    return round(sum(int(n) * factors[u] for n, u in parts), 2)


def profile_dirs(kind):
    system, user = profile_roots()
    dirs = []
    if system and system.is_dir():
        dirs += [d for d in system.glob(f"*/{kind}") if d.is_dir()]
    if user and user.is_dir():
        dirs += [d / kind for d in user.iterdir()
                 if d.is_dir() and "backup" not in d.name.lower() and (d / kind).is_dir()]
        if kind == "filament":
            dirs += [d for d in user.glob(f"*/{kind}/*") if d.is_dir()]
    return dirs


def resolve_profile_chain(path, kind):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return str(path)
    inherits = data.get("inherits")
    if not isinstance(inherits, str) or not inherits:
        return str(path)
    candidates = []
    if Path(inherits).suffix == ".json":
        candidates.append(Path(inherits))
    for d in profile_dirs(kind):
        candidates.append(d / f"{inherits}.json")
    parent = next((c for c in candidates if c.is_file()
                   and Path(c).resolve() != Path(path).resolve()), None)
    if not parent:
        return str(path)
    return str(parent) + ";" + str(path)


def extract_slice_stats(gcode_path):
    text = gcode_path.read_text(encoding="utf-8", errors="ignore")
    minutes = None
    m = re.search(r";\s*estimated printing time \(normal mode\)\s*=\s*(.+)", text)
    if not m:
        m = re.search(r";\s*total estimated time:\s*([^;\r\n]+)", text)
    if m:
        minutes = parse_duration(m.group(1))
    grams = None
    m = re.search(r";\s*total filament used \[g\]\s*=\s*([\d.]+)", text)
    if not m:
        m = re.search(r";\s*filament used \[g\]\s*=\s*([\d.]+)", text)
    if m:
        grams = round(float(m.group(1)), 2)
    return minutes, grams


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024  # 512 MB
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # kein Caching, damit Änderungen sofort ankommen


@app.after_request
def no_cache(response):
    if request.path.startswith("/static") or request.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(Exception)
def log_error(e):
    from werkzeug.exceptions import HTTPException
    code = getattr(e, "code", None) or 500
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description}), code
    app.logger.exception("Fehler bei %s %s", request.method, request.path)
    return jsonify({"error": str(e)}), code


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    runs INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material TEXT NOT NULL DEFAULT 'PLA',
    color TEXT NOT NULL DEFAULT 'unbekannt',
    color_hex TEXT NOT NULL DEFAULT '#888888',
    label TEXT NOT NULL DEFAULT '',
    total_g REAL NOT NULL DEFAULT 1000,
    remaining_g REAL NOT NULL DEFAULT 1000,
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    copies INTEGER NOT NULL DEFAULT 1,
    copies_printed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'geplant',
    time_min REAL NOT NULL DEFAULT 0,
    filament_g REAL NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL DEFAULT '',
    web_url TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_stored TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    queue_pos INTEGER,
    spool_id INTEGER REFERENCES spools(id) ON DELETE SET NULL,
    spool_booked_g REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    done_at TEXT
);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)
        spool_cols = [r[1] for r in db.execute("PRAGMA table_info(spools)").fetchall()]
        if "count" not in spool_cols:
            db.execute("ALTER TABLE spools ADD COLUMN count INTEGER NOT NULL DEFAULT 1")
        part_cols = [r[1] for r in db.execute("PRAGMA table_info(parts)").fetchall()]
        if "copies_printed" not in part_cols:
            db.execute("ALTER TABLE parts ADD COLUMN copies_printed INTEGER NOT NULL DEFAULT 0")
            db.execute("UPDATE parts SET copies_printed = copies WHERE status IN ('gedruckt', 'montiert')")
        project_cols = [r[1] for r in db.execute("PRAGMA table_info(projects)").fetchall()]
        for col in ("notes", "url"):
            if col not in project_cols:
                db.execute(f"ALTER TABLE projects ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if "runs" not in project_cols:
            db.execute("ALTER TABLE projects ADD COLUMN runs INTEGER NOT NULL DEFAULT 1")


def now():
    return datetime.now().isoformat(timespec="seconds")


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def required_copies(part, runs):
    return max(1, int(part["copies"] or 1)) * max(1, int(runs or 1))


def project_runs(db, project_id):
    row = db.execute("SELECT runs FROM projects WHERE id = ?", (project_id,)).fetchone()
    return max(1, int(row["runs"] or 1)) if row else 1


def normalize_project_parts(db, project_id, runs):
    parts = db.execute("SELECT * FROM parts WHERE project_id = ?", (project_id,)).fetchall()
    max_pos = db.execute("SELECT COALESCE(MAX(queue_pos), 0) m FROM parts").fetchone()["m"]
    for p in parts:
        required = required_copies(p, runs)
        if p["copies_printed"] >= required:
            if p["status"] == "queue":
                db.execute(
                    "UPDATE parts SET status='gedruckt', queue_pos=NULL, done_at=COALESCE(done_at, ?) WHERE id=?",
                    (now(), p["id"]),
                )
        elif p["status"] in ("gedruckt", "montiert"):
            max_pos += 1
            db.execute(
                "UPDATE parts SET status='queue', queue_pos=?, done_at=NULL WHERE id=?",
                (max_pos, p["id"]),
            )


# ---------------------------------------------------------------- helpers

def book_amount(filament_g, copies):
    return (filament_g or 0.0) * (copies or 0)


def consume_spool(cursor, sid, grams):
    """Zieht Gramm von einer Spulengruppe (Rest pro Spule × Anzahl)."""
    s = cursor.execute("SELECT total_g, remaining_g, count FROM spools WHERE id = ?", (sid,)).fetchone()
    if not s:
        return
    total, remaining, count = s["total_g"], s["remaining_g"], max(1, s["count"] or 1)
    want = grams
    while want > 0 and (remaining > 0 or count > 1):
        if remaining <= 0:
            count -= 1
            remaining = total
        take = min(want, remaining)
        remaining -= take
        want -= take
    cursor.execute("UPDATE spools SET remaining_g = ?, count = ? WHERE id = ?", (remaining, count, sid))


def return_spool(cursor, sid, grams):
    """Gibt Gramm an eine Spulengruppe zurück; Überschuss wird zu neuen vollen Spulen."""
    s = cursor.execute("SELECT total_g, remaining_g, count FROM spools WHERE id = ?", (sid,)).fetchone()
    if not s:
        return
    total = max(0.0, s["total_g"])
    remaining = max(0.0, s["remaining_g"]) + grams
    count = max(1, s["count"] or 1)
    while remaining > total > 0:
        count += 1
        remaining -= total
    cursor.execute("UPDATE spools SET remaining_g = ?, count = ? WHERE id = ?", (remaining, count, sid))


def apply_booking(cursor, spool_id, delta_g):
    if not spool_id or not delta_g:
        return
    if delta_g > 0:
        consume_spool(cursor, spool_id, delta_g)
    else:
        return_spool(cursor, spool_id, -delta_g)


def safe_filename(name):
    name = os.path.basename(name or "")
    name = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return name or "teil"


def save_upload(file):
    ext = Path(file.filename).suffix or ".stl"
    stored = f"{uuid.uuid4().hex}{ext}"
    dest = FILES_DIR / stored
    file.save(dest)
    return stored, safe_filename(Path(file.filename).stem) + ext, dest.stat().st_size


# ---------------------------------------------------------------- static

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------------------------------------------------------------- projects

@app.get("/api/projects")
def list_projects():
    rows = get_db().execute(
        """
        SELECT p.*,
               COUNT(pt.id) AS parts_count,
               COALESCE(SUM(pt.copies * p.runs), 0) AS copies_total,
               COALESCE(SUM(MIN(pt.copies_printed, pt.copies * p.runs)), 0) AS copies_done,
               COALESCE(SUM((pt.copies * p.runs - MIN(pt.copies_printed, pt.copies * p.runs)) * pt.time_min), 0) AS time_open,
               COALESCE(SUM(pt.time_min * pt.copies * p.runs), 0) AS time_total,
               COALESCE(SUM(pt.filament_g * pt.copies * p.runs), 0) AS filament_total,
               COALESCE(SUM((pt.copies * p.runs - MIN(pt.copies_printed, pt.copies * p.runs)) * pt.filament_g), 0) AS filament_open
        FROM projects p LEFT JOIN parts pt ON pt.project_id = p.id
        GROUP BY p.id ORDER BY p.created_at DESC
        """
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/projects")
def create_project():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        abort(400, terr("name_required"))
    db = get_db()
    if db.execute("SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE", (name,)).fetchone():
        abort(409, terr("project_exists", name=name))
    runs = max(1, int(data.get("runs") or 1))
    cur = db.execute(
        "INSERT INTO projects (name, description, notes, url, runs, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (name, data.get("description", ""), data.get("notes", ""), data.get("url", ""), runs, now()),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute(
        "SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/projects/<int:pid>")
def update_project(pid):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        abort(404)
    name = (data.get("name") or row["name"]).strip()
    if not name:
        abort(400, terr("name_required"))
    if name.lower() != row["name"].lower() and db.execute(
            "SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND id != ?", (name, pid)).fetchone():
        abort(409, terr("project_exists", name=name))
    runs = max(1, int(data.get("runs", row["runs"]) or 1))
    db.execute(
        "UPDATE projects SET name = ?, description = ?, notes = ?, url = ?, runs = ? WHERE id = ?",
        (name, data.get("description", row["description"]),
         data.get("notes", row["notes"]), data.get("url", row["url"]), runs, pid),
    )
    normalize_project_parts(db, pid, runs)
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()))


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    db = get_db()
    # Zugehörige Dateien aufräumen
    rows = db.execute("SELECT file_stored FROM parts WHERE project_id = ? AND file_stored != ''", (pid,)).fetchall()
    for r in rows:
        f = FILES_DIR / r["file_stored"]
        if f.exists():
            f.unlink()
    db.execute("DELETE FROM parts WHERE project_id = ?", (pid,))
    db.execute("DELETE FROM projects WHERE id = ?", (pid,))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    row = get_db().execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


# ---------------------------------------------------------------- parts

PART_FIELDS = ["name", "copies", "status", "time_min", "filament_g", "file_path",
               "web_url", "priority", "spool_id", "notes"]


@app.get("/api/parts")
def list_parts():
    project_id = request.args.get("project_id", type=int)
    status = request.args.get("status")
    q = ("SELECT p.*, pr.name AS project_name, pr.runs AS project_runs, "
         "s.material AS spool_material, s.color AS spool_color, s.color_hex AS spool_color_hex "
         "FROM parts p "
         "LEFT JOIN projects pr ON pr.id = p.project_id "
         "LEFT JOIN spools s ON s.id = p.spool_id")
    conds, args = [], []
    if project_id:
        conds.append("p.project_id = ?")
        args.append(project_id)
    if status:
        conds.append("p.status = ?")
        args.append(status)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    order = ("CASE WHEN p.queue_pos IS NULL THEN 1 ELSE 0 END, p.queue_pos, p.priority DESC, p.id"
             if status == "queue" else "p.priority DESC, p.id")
    rows = get_db().execute(q + " ORDER BY " + order, args).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


def validate_part(data, current=None):
    if "status" in data and data["status"] not in STATUSES:
        abort(400, terr("invalid_status"))
    if "copies" in data and int(data["copies"] or 1) < 1:
        abort(400, terr("copies_min"))


@app.post("/api/parts")
def create_part():
    data = request.form if request.form else (request.get_json(silent=True) or {})
    validate_part(data)
    project_id = int(data.get("project_id") or 0)
    db = get_db()
    if not db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
        abort(400, terr("project_missing"))
    name = safe_filename(data.get("name") or "Teil")
    copies = max(1, int(data.get("copies") or 1))
    status = data.get("status") or "geplant"
    file_stored, file_name, file_size = "", "", 0
    if "file" in request.files and request.files["file"].filename:
        file_stored, file_name, file_size = save_upload(request.files["file"])
        name = safe_filename(Path(file_name).stem) if data.get("name", "") == "" else name
    queue_pos = None
    if status == "queue":
        m = db.execute("SELECT COALESCE(MAX(queue_pos), 0) m FROM parts").fetchone()
        queue_pos = m["m"] + 1
    copies_printed = required_copies({"copies": copies}, project_runs(db, project_id)) \
        if STATUS_IDX[status] >= PRINTED_IDX else 0
    cur = db.execute(
        """INSERT INTO parts (project_id, name, copies, copies_printed, status, time_min, filament_g,
           file_path, web_url, file_name, file_stored, file_size, priority, queue_pos,
           spool_id, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (project_id, name, copies, copies_printed, status, float(data.get("time_min") or 0),
         float(data.get("filament_g") or 0), data.get("file_path") or "",
         data.get("web_url") or "", file_name, file_stored, file_size,
         int(data.get("priority") or 0), queue_pos,
         int(data["spool_id"]) if data.get("spool_id") else None,
         data.get("notes") or "", now()),
    )
    part = db.execute("SELECT * FROM parts WHERE id = ?", (cur.lastrowid,)).fetchone()
    amount = book_amount(part["filament_g"], part["copies_printed"])
    if part["spool_id"] and amount > 0:
        apply_booking(db, part["spool_id"], amount)
        db.execute("UPDATE parts SET spool_booked_g = ? WHERE id = ?", (amount, cur.lastrowid))
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.get("/api/parts/<int:pid>")
def get_part(pid):
    row = get_db().execute(
        "SELECT p.*, pr.name AS project_name, pr.runs AS project_runs, "
        "s.material AS spool_material, s.color AS spool_color, s.color_hex AS spool_color_hex "
        "FROM parts p LEFT JOIN projects pr ON pr.id = p.project_id "
        "LEFT JOIN spools s ON s.id = p.spool_id WHERE p.id = ?", (pid,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


@app.put("/api/parts/<int:pid>")
def update_part(pid):
    db = get_db()
    part = db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part:
        abort(404)
    data = request.get_json(force=True)
    validate_part(data, part)
    merged = {k: data.get(k, part[k]) for k in
              ["name", "copies", "status", "time_min", "filament_g", "file_path",
               "web_url", "priority", "spool_id", "notes"]}
    merged["copies"] = max(1, int(merged["copies"] or 1))
    merged["time_min"] = float(merged["time_min"] or 0)
    merged["filament_g"] = float(merged["filament_g"] or 0)
    merged["priority"] = int(merged["priority"] or 0)
    merged["spool_id"] = int(merged["spool_id"]) if merged["spool_id"] else None
    merged["name"] = (merged["name"] or "").strip() or part["name"]
    new_status = merged["status"]
    runs = project_runs(db, part["project_id"])
    required = required_copies(merged, runs)

    printed = part["copies_printed"]
    if STATUS_IDX[new_status] >= PRINTED_IDX:
        printed = required
    elif STATUS_IDX[part["status"]] >= PRINTED_IDX:
        printed = 0
    if printed > required:
        abort(400, terr("copies_below_printed"))

    queue_pos = part["queue_pos"]
    if new_status == "queue" and part["status"] != "queue":
        m = db.execute("SELECT COALESCE(MAX(queue_pos), 0) m FROM parts").fetchone()
        queue_pos = m["m"] + 1
    elif new_status != "queue":
        queue_pos = None

    done_at = part["done_at"]
    if printed >= required and not done_at:
        done_at = now()
    elif printed < required:
        done_at = None

    old_booked = part["spool_booked_g"] or 0.0
    new_booked = old_booked
    if part["spool_id"] != merged["spool_id"]:
        if part["spool_id"] and old_booked:
            apply_booking(db, part["spool_id"], -old_booked)
        if merged["spool_id"]:
            if old_booked:
                apply_booking(db, merged["spool_id"], old_booked)
        else:
            new_booked = 0.0
    printed_delta = printed - part["copies_printed"]
    if merged["spool_id"] and printed_delta:
        delta_g = book_amount(merged["filament_g"], printed_delta)
        apply_booking(db, merged["spool_id"], delta_g)
        new_booked += delta_g
    new_booked = max(0.0, new_booked)

    db.execute(
        """UPDATE parts SET name=?, copies=?, copies_printed=?, status=?, time_min=?, filament_g=?,
           file_path=?, web_url=?, priority=?, spool_id=?, notes=?, queue_pos=?, done_at=?, spool_booked_g=?
           WHERE id=?""",
        (merged["name"], merged["copies"], printed, new_status, merged["time_min"],
         merged["filament_g"], merged["file_path"] or "", merged["web_url"] or "",
         merged["priority"], merged["spool_id"], merged["notes"] or "",
         queue_pos, done_at, round(new_booked, 3), pid),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()))


@app.post("/api/parts/<int:pid>/print")
def record_printed_copies(pid):
    db = get_db()
    part = db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part:
        abort(404)
    data = request.get_json(force=True)
    try:
        amount = int(data.get("copies") or 0)
    except (TypeError, ValueError):
        amount = 0
    if amount < 1:
        abort(400, terr("print_count_invalid"))
    required = required_copies(part, project_runs(db, part["project_id"]))
    remaining = required - part["copies_printed"]
    if part["status"] != "queue":
        abort(400, terr("not_in_queue"))
    if amount > remaining:
        abort(400, terr("print_count_excess", remaining=remaining))

    printed = part["copies_printed"] + amount
    complete = printed >= required
    new_status = "gedruckt" if complete else "queue"
    new_queue_pos = None if complete else part["queue_pos"]
    done_at = now() if complete else None
    new_booked = part["spool_booked_g"] or 0.0
    add_g = book_amount(part["filament_g"], amount)
    if part["spool_id"] and add_g:
        apply_booking(db, part["spool_id"], add_g)
        new_booked += add_g
    db.execute(
        """UPDATE parts SET copies_printed=?, status=?, queue_pos=?, done_at=?, spool_booked_g=?
           WHERE id=?""",
        (printed, new_status, new_queue_pos, done_at, round(new_booked, 3), pid),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()))


@app.post("/api/parts/<int:pid>/unprint")
def unprint_copies(pid):
    db = get_db()
    part = db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part:
        abort(404)
    data = request.get_json(silent=True) or {}
    try:
        amount = int(data.get("copies", 1))
    except (TypeError, ValueError):
        amount = 0
    if amount < 1:
        abort(400, terr("unprint_count_invalid"))
    printed = part["copies_printed"]
    if amount > printed:
        abort(400, terr("unprint_count_excess", printed=printed))

    printed -= amount
    refund = data.get("refund", True)
    if isinstance(refund, str):
        refund = refund.strip().lower() not in ("0", "false", "no", "nein")
    queue_pos = part["queue_pos"]
    if part["status"] != "queue" or queue_pos is None:
        max_pos = db.execute("SELECT COALESCE(MAX(queue_pos), 0) m FROM parts").fetchone()["m"]
        queue_pos = max_pos + 1
    old_booked = part["spool_booked_g"] or 0.0
    new_booked = old_booked
    if refund and part["spool_id"]:
        refund_g = min(old_booked, book_amount(part["filament_g"], amount))
        if refund_g:
            apply_booking(db, part["spool_id"], -refund_g)
            new_booked = old_booked - refund_g
    db.execute(
        """UPDATE parts SET copies_printed=?, status='queue', queue_pos=?, done_at=NULL,
           spool_booked_g=? WHERE id=?""",
        (printed, queue_pos, round(new_booked, 3), pid),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()))


@app.delete("/api/parts/<int:pid>")
def delete_part(pid):
    db = get_db()
    part = db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part:
        abort(404)
    if part["spool_booked_g"]:
        apply_booking(db, part["spool_id"], -part["spool_booked_g"])
    if part["file_stored"]:
        f = FILES_DIR / part["file_stored"]
        if f.exists():
            f.unlink()
    db.execute("DELETE FROM parts WHERE id = ?", (pid,))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/parts/<int:pid>/file")
def replace_part_file(pid):
    db = get_db()
    part = db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part:
        abort(404)
    f = request.files.get("file")
    if not f or not f.filename:
        abort(400, terr("no_file"))
    if part["file_stored"]:
        old = FILES_DIR / part["file_stored"]
        if old.exists():
            old.unlink()
    stored, fname, size = save_upload(f)
    db.execute("UPDATE parts SET file_name = ?, file_stored = ?, file_size = ? WHERE id = ?",
               (fname, stored, size, pid))
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()))


@app.get("/api/parts/<int:pid>/file")
def download_part_file(pid):
    part = get_db().execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part or not part["file_stored"]:
        abort(404)
    return send_from_directory(FILES_DIR, part["file_stored"],
                               as_attachment=True, download_name=part["file_name"])


@app.post("/api/parts/<int:pid>/open-explorer")
def open_explorer(pid):
    """Öffnet den Explorer mit dem hinterlegten lokalen Pfad (gleicher Rechner)."""
    part = get_db().execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part or not part["file_path"]:
        abort(404)
    p = Path(part["file_path"])
    if not p.exists():
        abort(404, terr("path_missing", path=part["file_path"]))
    subprocess.Popen(["explorer", "/select,", str(p)])
    return jsonify({"ok": True})


@app.post("/api/parts/<int:pid>/open-slicer")
def open_in_slicer(pid):
    require_local()
    part = get_db().execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part or not part["file_stored"]:
        abort(404)
    src = FILES_DIR / part["file_stored"]
    if not src.exists():
        abort(404)
    settings = load_settings()
    exe = (settings.get("slicer_path") or "").strip() or detect_slicer()
    if not exe:
        abort(400, terr("slicer_not_configured"))
    if not Path(exe).is_file():
        abort(400, terr("slicer_invalid", path=exe))
    out_dir = Path(tempfile.gettempdir()) / "printmanager"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / safe_filename(part["file_name"] or src.name)
    shutil.copyfile(src, dest)
    args = [exe]
    exe_name = Path(exe).name.lower()
    if any(k in exe_name for k in ("anycubic", "orca", "bambu")):
        args.append("--single-instance")
    args.append(str(dest))
    subprocess.Popen(args)
    return jsonify({"ok": True})


SLICE_TIMEOUT = int(os.environ.get("PM_SLICE_TIMEOUT", "300"))


@app.post("/api/parts/<int:pid>/slice")
def slice_part(pid):
    require_local()
    part = get_db().execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()
    if not part or not part["file_stored"]:
        abort(404)
    src = FILES_DIR / part["file_stored"]
    if not src.exists():
        abort(404)
    exe = slicer_exe()
    if not exe:
        abort(400, terr("slicer_not_configured"))
    settings = load_settings()
    saved = settings.get("profiles") or {}
    chosen = (request.get_json(silent=True) or {}).get("profiles") or {}
    machine = (chosen.get("machine") or saved.get("machine") or "").strip()
    process = (chosen.get("process") or saved.get("process") or "").strip()
    filament = (chosen.get("filament") or saved.get("filament") or "").strip()
    if not (machine and process and filament):
        abort(400, terr("slicer_profile_missing"))
    for profile in (machine, process, filament):
        if not Path(profile).is_file():
            abort(400, terr("slicer_profile_invalid", path=profile))

    base_tmp = Path(tempfile.gettempdir()) / "printmanager"
    base_tmp.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="slice-", dir=str(base_tmp)))
    outdir = work / "out"
    outdir.mkdir()
    input_path = work / safe_filename(part["file_name"] or src.name)
    shutil.copyfile(src, input_path)
    args = [exe, "--load-settings", machine + ";" + resolve_profile_chain(process, "process"),
            "--load-filaments", filament, "--orient", "1", "--slice", "0",
            "--outputdir", str(outdir), str(input_path)]
    try:
        result = subprocess.run(args, capture_output=True, text=True, errors="ignore",
                                timeout=SLICE_TIMEOUT)
        gcodes = sorted(outdir.rglob("*.gcode"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not gcodes:
            lines = [ln for ln in ((result.stderr or "") + "\n" + (result.stdout or "")).splitlines() if ln.strip()]
            msg = lines[-1][:200] if lines else "kein G-Code erzeugt"
            abort(400, terr("slicer_slice_failed", msg=msg))
        minutes, grams = extract_slice_stats(gcodes[0])
        if minutes is None or grams is None:
            abort(400, terr("slicer_slice_failed",
                            msg="Druckzeit oder Filament im G-Code nicht gefunden"))
        db = get_db()
        db.execute("UPDATE parts SET time_min = ?, filament_g = ? WHERE id = ?",
                   (minutes, grams, pid))
        db.commit()
        return jsonify({"ok": True, "time_min": minutes, "filament_g": grams})
    except subprocess.TimeoutExpired:
        abort(400, terr("slicer_timeout"))
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.get("/api/slicer/profiles")
def slicer_profiles():
    require_local()
    return jsonify(list_slicer_profiles())


# ---------------------------------------------------------------- settings

@app.get("/api/settings")
def get_settings():
    require_local()
    settings = load_settings()
    configured = (settings.get("slicer_path") or "").strip()
    profiles = settings.get("profiles") or {}
    return jsonify({
        "slicer_path": configured,
        "detected_path": detect_slicer(),
        "slicer_exists": bool(configured and Path(configured).is_file()),
        "profiles": {k: (profiles.get(k) or "") for k in PROFILE_KINDS},
    })


@app.put("/api/settings")
def update_settings():
    require_local()
    data = request.get_json(force=True)
    path = (data.get("slicer_path") or "").strip()
    if path and not Path(path).is_file():
        abort(400, terr("slicer_invalid", path=path))
    settings = load_settings()
    settings["slicer_path"] = path
    incoming = data.get("profiles")
    if isinstance(incoming, dict):
        profiles = settings.get("profiles") or {}
        for kind in PROFILE_KINDS:
            if kind in incoming:
                value = (incoming.get(kind) or "").strip()
                if value and not Path(value).is_file():
                    abort(400, terr("slicer_profile_invalid", path=value))
                profiles[kind] = value
        settings["profiles"] = profiles
    save_settings(settings)
    return jsonify({"slicer_path": path, "profiles": settings.get("profiles") or {}})


# ---------------------------------------------------------------- queue

@app.post("/api/queue/reorder")
def reorder_queue():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    db = get_db()
    for pos, pid in enumerate(ids, start=1):
        db.execute("UPDATE parts SET queue_pos = ? WHERE id = ?", (pos, pid))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- spools

@app.get("/api/spools")
def list_spools():
    rows = get_db().execute(
        """SELECT s.*,
                  COUNT(p.id) AS parts_count,
                  COALESCE(SUM(MAX(p.copies * pr.runs - p.copies_printed, 0) * p.filament_g), 0) AS planned_g
           FROM spools s
           LEFT JOIN parts p ON p.spool_id = s.id
           LEFT JOIN projects pr ON pr.id = p.project_id
           GROUP BY s.id ORDER BY s.created_at DESC""").fetchall()
    result = []
    for row in rows:
        data = row_to_dict(row)
        data["available_g"] = (data["remaining_g"] or 0) + max(0, (data["count"] or 1) - 1) * (data["total_g"] or 0)
        data["missing_g"] = max(0, data["planned_g"] - data["available_g"])
        result.append(data)
    return jsonify(result)


SPOOL_FIELDS = ["material", "color", "color_hex", "label", "total_g", "remaining_g", "count"]


@app.post("/api/spools")
def create_spool():
    data = request.get_json(force=True)
    db = get_db()
    total = float(data.get("total_g") or 1000)
    count = max(1, int(data.get("count") or 1))
    cur = db.execute(
        "INSERT INTO spools (material, color, color_hex, label, total_g, remaining_g, count, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ((data.get("material") or "PLA").strip(), (data.get("color") or "unbekannt").strip(),
         data.get("color_hex") or "#888888", data.get("label") or "", total,
         float(data.get("remaining_g", total)), count, now()),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM spools WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/spools/<int:sid>")
def update_spool(sid):
    db = get_db()
    row = db.execute("SELECT * FROM spools WHERE id = ?", (sid,)).fetchone()
    if not row:
        abort(404)
    data = request.get_json(force=True)
    merged = {k: data.get(k, row[k]) for k in SPOOL_FIELDS}
    total = max(0.0, float(merged["total_g"] or 0))
    remaining = min(max(0.0, float(merged["remaining_g"] or 0)), total)
    count = max(1, int(merged["count"] or 1))
    db.execute(
        "UPDATE spools SET material=?, color=?, color_hex=?, label=?, total_g=?, remaining_g=?, count=? WHERE id=?",
        ((merged["material"] or "PLA").strip(), (merged["color"] or "unbekannt").strip(),
         merged["color_hex"] or "#888888", merged["label"] or "", total, remaining, count, sid),
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM spools WHERE id = ?", (sid,)).fetchone()))


@app.post("/api/spools/<int:sid>/refill")
def refill_spool(sid):
    db = get_db()
    row = db.execute("SELECT * FROM spools WHERE id = ?", (sid,)).fetchone()
    if not row:
        abort(404)
    add = float(request.get_json(force=True).get("amount_g") or 0)
    if add > 0:
        return_spool(db, sid, add)
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM spools WHERE id = ?", (sid,)).fetchone()))


@app.delete("/api/spools/<int:sid>")
def delete_spool(sid):
    db = get_db()
    booked = db.execute("SELECT COALESCE(SUM(spool_booked_g),0) s FROM parts WHERE spool_id = ? AND spool_booked_g > 0",
                        (sid,)).fetchone()["s"]
    if booked:
        abort(400, terr("spool_booked"))
    db.execute("UPDATE parts SET spool_id = NULL WHERE spool_id = ?", (sid,))
    db.execute("DELETE FROM spools WHERE id = ?", (sid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- export / import

EXPORT_FORMAT = "printmanager-export"
EXPORT_VERSION = 3

PART_EXPORT_FIELDS = ["name", "copies", "copies_printed", "status", "time_min", "filament_g", "file_path",
                      "web_url", "file_name", "file_stored", "file_size", "priority",
                      "queue_pos", "spool_booked_g", "notes", "created_at", "done_at"]
SPOOL_EXPORT_FIELDS = ["material", "color", "color_hex", "label", "total_g",
                       "remaining_g", "count", "created_at"]


def _build_export(db, kind, project_ids):
    if kind == "full":
        spools = db.execute("SELECT * FROM spools ORDER BY id").fetchall()
        projects = db.execute("SELECT * FROM projects ORDER BY id").fetchall()
    else:
        spools = db.execute(
            "SELECT DISTINCT s.* FROM spools s JOIN parts p ON p.spool_id = s.id "
            f"WHERE p.project_id IN ({','.join('?' * len(project_ids))}) ORDER BY s.id",
            project_ids).fetchall()
        projects = db.execute(
            f"SELECT * FROM projects WHERE id IN ({','.join('?' * len(project_ids))}) ORDER BY id",
            project_ids).fetchall()
    spool_index = {s["id"]: i for i, s in enumerate(spools)}
    manifest = {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "kind": kind,
        "created_at": now(),
        "spools": [{k: s[k] for k in SPOOL_EXPORT_FIELDS} for s in spools],
        "projects": [],
    }
    files = set()
    for pr in projects:
        parts = db.execute("SELECT * FROM parts WHERE project_id = ? ORDER BY id", (pr["id"],)).fetchall()
        pj = {"name": pr["name"], "description": pr["description"],
              "notes": pr["notes"], "url": pr["url"], "runs": pr["runs"],
              "created_at": pr["created_at"], "parts": []}
        for pt in parts:
            d = row_to_dict(pt)
            pj["parts"].append({**{k: d[k] for k in PART_EXPORT_FIELDS},
                                "spool_ref": spool_index.get(d["spool_id"])})
            if d["file_stored"]:
                files.add(d["file_stored"])
        manifest["projects"].append(pj)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for stored in sorted(files):
            p = FILES_DIR / stored
            if p.exists():
                z.write(p, f"files/{stored}")
    buf.seek(0)
    return buf, len(projects), sum(len(p["parts"]) for p in manifest["projects"])


@app.get("/api/export/project/<int:pid>")
def export_project(pid):
    db = get_db()
    if not db.execute("SELECT 1 FROM projects WHERE id = ?", (pid,)).fetchone():
        abort(404)
    buf, n_projects, n_parts = _build_export(db, "project", [pid])
    pr = db.execute("SELECT name FROM projects WHERE id = ?", (pid,)).fetchone()
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    fname = f"projekt_{safe_filename(pr['name'])}_{stamp}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


@app.get("/api/export/full")
def export_full():
    db = get_db()
    buf, n_projects, n_parts = _build_export(db, "full", [])
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"printmanager_backup_{stamp}.zip")


@app.post("/api/import")
def import_zip():
    f = request.files.get("file")
    if not f or not f.filename:
        abort(400, terr("no_zip"))
    mode = request.form.get("mode", "merge")
    if mode not in ("merge", "restore"):
        abort(400, terr("invalid_mode"))
    try:
        z = zipfile.ZipFile(io.BytesIO(f.read()))
        manifest = json.loads(z.read("manifest.json"))
    except Exception:
        abort(400, terr("bad_zip"))
    if manifest.get("format") != EXPORT_FORMAT:
        abort(400, terr("unknown_format"))
    version = manifest.get("version", 0)
    if version > EXPORT_VERSION:
        abort(400, terr("newer_version"))

    db = get_db()
    if mode == "restore":
        for r in db.execute("SELECT file_stored FROM parts WHERE file_stored != ''").fetchall():
            p = FILES_DIR / r["file_stored"]
            if p.exists():
                p.unlink()
        db.execute("DELETE FROM parts")
        db.execute("DELETE FROM projects")
        db.execute("DELETE FROM spools")

    spool_map = {}
    for i, s in enumerate(manifest.get("spools", [])):
        cur = db.execute(
            "INSERT INTO spools (material, color, color_hex, label, total_g, remaining_g, count, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (s.get("material") or "PLA", s.get("color") or "unbekannt",
             s.get("color_hex") or "#888888", s.get("label") or "",
             float(s.get("total_g") or 0), float(s.get("remaining_g") or 0),
             max(1, int(s.get("count") or 1)), s.get("created_at") or now()))
        spool_map[i] = cur.lastrowid

    n_parts = 0
    for pr in manifest.get("projects", []):
        name = (pr.get("name") or "Import").strip() or "Import"
        if mode == "merge" and db.execute(
                "SELECT 1 FROM projects WHERE name = ?", (name,)).fetchone():
            name += " (Import)"
        cur = db.execute(
            "INSERT INTO projects (name, description, notes, url, runs, created_at) VALUES (?,?,?,?,?,?)",
            (name, pr.get("description") or "", pr.get("notes") or "",
             pr.get("url") or "", max(1, int(pr.get("runs") or 1)),
             pr.get("created_at") or now()))
        proj_id = cur.lastrowid
        project_run_count = max(1, int(pr.get("runs") or 1))
        for pt in pr.get("parts", []):
            status = pt.get("status") if pt.get("status") in STATUSES else "geplant"
            stored = pt.get("file_stored") or ""
            if stored:
                src = None
                try:
                    src = z.read(f"files/{stored}")
                except KeyError:
                    stored = ""
                if src is not None:
                    dest = FILES_DIR / stored
                    if dest.exists():  # Kollision: neue UUID vergeben
                        stored = f"{uuid.uuid4().hex}{Path(stored).suffix}"
                        dest = FILES_DIR / stored
                    dest.write_bytes(src)
            spool_id = spool_map.get(pt.get("spool_ref"))
            idx = STATUS_IDX[status]
            copies = max(1, int(pt.get("copies") or 1))
            required = copies * project_run_count
            default_printed = required if idx >= PRINTED_IDX else 0
            copies_printed = max(0, int(pt.get("copies_printed", default_printed) or 0))
            default_booked = float(pt.get("filament_g") or 0) * copies_printed
            booked_value = pt.get("spool_booked_g")
            booked = (float(booked_value) if booked_value is not None else default_booked) if spool_id else 0.0
            db.execute(
                """INSERT INTO parts (project_id, name, copies, copies_printed, status, time_min, filament_g,
                   file_path, web_url, file_name, file_stored, file_size, priority, queue_pos,
                   spool_id, spool_booked_g, notes, created_at, done_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (proj_id, pt.get("name") or "Teil", copies, copies_printed, status,
                 float(pt.get("time_min") or 0), float(pt.get("filament_g") or 0),
                 pt.get("file_path") or "", pt.get("web_url") or "",
                 pt.get("file_name") or "", stored, int(pt.get("file_size") or 0),
                 int(pt.get("priority") or 0),
                 pt.get("queue_pos") if status == "queue" else None,
                 spool_id, booked, pt.get("notes") or "",
                 pt.get("created_at") or now(),
                 pt.get("done_at") if copies_printed >= required else None))
            n_parts += 1
    db.commit()
    return jsonify({"ok": True, "mode": mode,
                    "projects": len(manifest.get("projects", [])),
                    "parts": n_parts,
                    "spools": len(manifest.get("spools", []))})


# ---------------------------------------------------------------- stats

@app.get("/api/stats")
def stats():
    db = get_db()
    g1 = db.execute("SELECT COUNT(*) projects FROM projects").fetchone()
    g2 = db.execute(
        """SELECT COUNT(*) parts,
                  COALESCE(SUM(pt.copies * pr.runs),0) copies,
                  COALESCE(SUM(MIN(pt.copies_printed, pt.copies * pr.runs)),0) copies_done,
                  COALESCE(SUM(pt.time_min*pt.copies*pr.runs),0) time_total,
                  COALESCE(SUM((pt.copies*pr.runs - MIN(pt.copies_printed, pt.copies*pr.runs))*pt.time_min),0) time_open,
                  COALESCE(SUM(pt.filament_g*pt.copies*pr.runs),0) filament_total,
                  COALESCE(SUM((pt.copies*pr.runs - MIN(pt.copies_printed, pt.copies*pr.runs))*pt.filament_g),0) filament_open,
                  COALESCE(SUM(CASE WHEN pt.spool_id IS NULL THEN
                    (pt.copies*pr.runs - MIN(pt.copies_printed, pt.copies*pr.runs))*pt.filament_g
                    ELSE 0 END),0) filament_unassigned
           FROM parts pt JOIN projects pr ON pr.id = pt.project_id""").fetchone()
    g3 = db.execute(
        "SELECT COALESCE(SUM(remaining_g + MAX(count - 1, 0) * total_g),0) remaining, "
        "COALESCE(SUM(total_g * count),0) total FROM spools").fetchone()
    booked = db.execute(
        "SELECT COALESCE(SUM(spool_booked_g),0) s FROM parts WHERE spool_booked_g > 0").fetchone()
    return jsonify({
        "projects": g1["projects"],
        "parts": g2["parts"],
        "copies": g2["copies"],
        "copies_done": g2["copies_done"],
        "time_total_min": g2["time_total"],
        "time_open_min": g2["time_open"],
        "filament_total_g": g2["filament_total"],
        "filament_open_g": g2["filament_open"],
        "filament_unassigned_g": g2["filament_unassigned"],
        "spool_remaining_g": g3["remaining"],
        "spool_total_g": g3["total"],
        "filament_booked_g": booked["s"],
    })


init_db()

if __name__ == "__main__":
    print("PrintManager läuft auf http://localhost:" + str(app.config.get("PORT", 5000)))
    app.run(host="0.0.0.0", port=int(os.environ.get("PM_PORT", "5000")), debug=False)
