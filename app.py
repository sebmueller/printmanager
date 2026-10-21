import io
import json
import os
import re
import sqlite3
import subprocess
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PM_DB", str(BASE / "data.db")))
FILES_DIR = Path(os.environ.get("PM_FILES", str(BASE / "files")))
FILES_DIR.mkdir(exist_ok=True)

STATUSES = ["geplant", "queue", "gedruckt", "montiert"]
STATUS_IDX = {s: i for i, s in enumerate(STATUSES)}
PRINTED_IDX = STATUS_IDX["gedruckt"]

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
    app.logger.exception("Fehler bei %s %s", request.method, request.path)
    code = getattr(e, "code", 500)
    if code is None:
        code = 500
    return jsonify({"error": str(e)}), code


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
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
        cols = [r[1] for r in db.execute("PRAGMA table_info(spools)").fetchall()]
        if "count" not in cols:
            db.execute("ALTER TABLE spools ADD COLUMN count INTEGER NOT NULL DEFAULT 1")


def now():
    return datetime.now().isoformat(timespec="seconds")


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


# ---------------------------------------------------------------- helpers

RANK_SQL = ("CASE {p}.status WHEN 'montiert' THEN 3 WHEN 'gedruckt' THEN 2 "
            "WHEN 'queue' THEN 1 ELSE 0 END")

def book_amount(filament_g, copies):
    return (filament_g or 0.0) * (copies or 1)


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
    rank = RANK_SQL.format(p="pt")
    rows = get_db().execute(
        f"""
        SELECT p.*,
               COUNT(pt.id) AS parts_count,
               COALESCE(SUM(pt.copies), 0) AS copies_total,
               COALESCE(SUM(CASE WHEN {rank} >= 2 THEN pt.copies ELSE 0 END), 0) AS copies_done,
               COALESCE(SUM(CASE WHEN {rank} <= 1 THEN pt.time_min * pt.copies ELSE 0 END), 0) AS time_open,
               COALESCE(SUM(pt.time_min * pt.copies), 0) AS time_total,
               COALESCE(SUM(pt.filament_g * pt.copies), 0) AS filament_total,
               COALESCE(SUM(CASE WHEN {rank} <= 1 THEN pt.filament_g * pt.copies ELSE 0 END), 0) AS filament_open
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
        abort(400, "Name fehlt")
    cur = get_db().execute(
        "INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)",
        (name, data.get("description", ""), now()),
    )
    get_db().commit()
    return jsonify(row_to_dict(get_db().execute(
        "SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/projects/<int:pid>")
def update_project(pid):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        abort(404)
    db.execute(
        "UPDATE projects SET name = ?, description = ? WHERE id = ?",
        ((data.get("name") or row["name"]).strip(), data.get("description", row["description"]), pid),
    )
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
    q = ("SELECT p.*, pr.name AS project_name, "
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
        abort(400, "Ungültiger Status")
    if "copies" in data and int(data["copies"] or 1) < 1:
        abort(400, "Kopien müssen >= 1 sein")


@app.post("/api/parts")
def create_part():
    data = request.form if request.form else (request.get_json(silent=True) or {})
    validate_part(data)
    project_id = int(data.get("project_id") or 0)
    db = get_db()
    if not db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
        abort(400, "Projekt existiert nicht")
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
    cur = db.execute(
        """INSERT INTO parts (project_id, name, copies, status, time_min, filament_g,
           file_path, web_url, file_name, file_stored, file_size, priority, queue_pos,
           spool_id, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (project_id, name, copies, status, float(data.get("time_min") or 0),
         float(data.get("filament_g") or 0), data.get("file_path") or "",
         data.get("web_url") or "", file_name, file_stored, file_size,
         int(data.get("priority") or 0), queue_pos,
         int(data["spool_id"]) if data.get("spool_id") else None,
         data.get("notes") or "", now()),
    )
    part = db.execute("SELECT * FROM parts WHERE id = ?", (cur.lastrowid,)).fetchone()
    amount = book_amount(part["filament_g"], part["copies"])
    if STATUS_IDX[status] >= PRINTED_IDX and part["spool_id"] and amount > 0:
        apply_booking(db, part["spool_id"], amount)
        db.execute("UPDATE parts SET spool_booked_g = ? WHERE id = ?", (amount, cur.lastrowid))
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM parts WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.get("/api/parts/<int:pid>")
def get_part(pid):
    row = get_db().execute(
        "SELECT p.*, pr.name AS project_name, "
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

    queue_pos = part["queue_pos"]
    if new_status == "queue" and part["status"] != "queue":
        m = db.execute("SELECT COALESCE(MAX(queue_pos), 0) m FROM parts").fetchone()
        queue_pos = m["m"] + 1
    elif new_status != "queue":
        queue_pos = None

    done_at = part["done_at"]
    if new_status == "gedruckt" and not done_at:
        done_at = now()
    elif STATUS_IDX[new_status] < PRINTED_IDX:
        done_at = None

    db.execute(
        """UPDATE parts SET name=?, copies=?, status=?, time_min=?, filament_g=?,
           file_path=?, web_url=?, priority=?, spool_id=?, notes=?, queue_pos=?, done_at=?
           WHERE id=?""",
        (merged["name"], merged["copies"], new_status, merged["time_min"],
         merged["filament_g"], merged["file_path"] or "", merged["web_url"] or "",
         merged["priority"], merged["spool_id"], merged["notes"] or "",
         queue_pos, done_at, pid),
    )
    old_idx = STATUS_IDX[part["status"]]
    new_idx = STATUS_IDX[new_status]
    old_booked = part["spool_booked_g"] or 0.0
    new_booked = old_booked

    if old_idx >= PRINTED_IDX and old_booked:
        # Alte Buchung immer auflösen (Spule könnte gewechselt haben)
        apply_booking(db, part["spool_id"], -old_booked)
        new_booked = 0.0
    if new_idx >= PRINTED_IDX and merged["spool_id"]:
        amount = book_amount(merged["filament_g"], merged["copies"])
        if amount > 0:
            apply_booking(db, merged["spool_id"], amount)
            new_booked = amount
    db.execute("UPDATE parts SET spool_booked_g = ? WHERE id = ?", (round(new_booked, 3), pid))
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
        abort(400, "Keine Datei übergeben")
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
        abort(404, "Pfad existiert nicht: " + part["file_path"])
    subprocess.Popen(["explorer", "/select,", str(p)])
    return jsonify({"ok": True})


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
                  (SELECT COUNT(*) FROM parts p WHERE p.spool_id = s.id) AS parts_count
           FROM spools s ORDER BY s.created_at DESC""").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


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
        abort(400, "Spule ist mit gebuchten Teilen verknüpft")
    db.execute("UPDATE parts SET spool_id = NULL WHERE spool_id = ?", (sid,))
    db.execute("DELETE FROM spools WHERE id = ?", (sid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- export / import

EXPORT_FORMAT = "printmanager-export"
EXPORT_VERSION = 1

PART_EXPORT_FIELDS = ["name", "copies", "status", "time_min", "filament_g", "file_path",
                      "web_url", "file_name", "file_stored", "file_size", "priority",
                      "queue_pos", "notes", "created_at", "done_at"]
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
        abort(400, "Keine ZIP-Datei übergeben")
    mode = request.form.get("mode", "merge")
    if mode not in ("merge", "restore"):
        abort(400, "Ungültiger Modus")
    try:
        z = zipfile.ZipFile(io.BytesIO(f.read()))
        manifest = json.loads(z.read("manifest.json"))
    except Exception:
        abort(400, "Ungültige ZIP-Datei (manifest.json fehlt oder ist beschädigt)")
    if manifest.get("format") != EXPORT_FORMAT:
        abort(400, "Unbekanntes Export-Format")
    version = manifest.get("version", 0)
    if version > EXPORT_VERSION:
        abort(400, "Export stammt von einer neueren Tool-Version")
    # Format-Migrationen für ältere Versionen kämen hier (aktuell nur v1)

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
        cur = db.execute("INSERT INTO projects (name, description, created_at) VALUES (?,?,?)",
                         (name, pr.get("description") or "", pr.get("created_at") or now()))
        proj_id = cur.lastrowid
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
            booked = (float(pt.get("filament_g") or 0) * int(pt.get("copies") or 1)
                      if idx >= PRINTED_IDX and spool_id else 0.0)
            db.execute(
                """INSERT INTO parts (project_id, name, copies, status, time_min, filament_g,
                   file_path, web_url, file_name, file_stored, file_size, priority, queue_pos,
                   spool_id, spool_booked_g, notes, created_at, done_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (proj_id, pt.get("name") or "Teil", max(1, int(pt.get("copies") or 1)), status,
                 float(pt.get("time_min") or 0), float(pt.get("filament_g") or 0),
                 pt.get("file_path") or "", pt.get("web_url") or "",
                 pt.get("file_name") or "", stored, int(pt.get("file_size") or 0),
                 int(pt.get("priority") or 0),
                 pt.get("queue_pos") if status == "queue" else None,
                 spool_id, booked, pt.get("notes") or "",
                 pt.get("created_at") or now(),
                 pt.get("done_at") if idx >= PRINTED_IDX else None))
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
    rank = RANK_SQL.format(p="pt")
    g1 = db.execute("SELECT COUNT(*) projects FROM projects").fetchone()
    g2 = db.execute(
        f"""SELECT COUNT(*) parts,
                  COALESCE(SUM(copies),0) copies,
                  COALESCE(SUM(CASE WHEN {rank} >= 2 THEN copies ELSE 0 END),0) copies_done,
                  COALESCE(SUM(time_min*copies),0) time_total,
                  COALESCE(SUM(CASE WHEN {rank} <= 1 THEN time_min*copies ELSE 0 END),0) time_open,
                  COALESCE(SUM(filament_g*copies),0) filament_total,
                  COALESCE(SUM(CASE WHEN {rank} <= 1 THEN filament_g*copies ELSE 0 END),0) filament_open
           FROM parts pt""").fetchone()
    g3 = db.execute(
        "SELECT COALESCE(SUM(remaining_g * count),0) remaining, COALESCE(SUM(total_g * count),0) total FROM spools").fetchone()
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
        "spool_remaining_g": g3["remaining"],
        "spool_total_g": g3["total"],
        "filament_booked_g": booked["s"],
    })


init_db()

if __name__ == "__main__":
    print("PrintManager läuft auf http://localhost:" + str(app.config.get("PORT", 5000)))
    app.run(host="0.0.0.0", port=int(os.environ.get("PM_PORT", "5000")), debug=False)
