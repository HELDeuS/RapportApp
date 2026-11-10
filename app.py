import math
import os
import sqlite3

from flask import Flask, g, jsonify, request, send_from_directory

import openpyxl

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("RAPPORTAPP_DB", os.path.join(APP_DIR, "rapportapp.db"))

app = Flask(__name__, static_folder="static", static_url_path="/static")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


app.teardown_appcontext(close_db)


SCHEMA = """
CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    niveau TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    student_number TEXT DEFAULT '',
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    UNIQUE (student_id, subject_id, period_id)
);
"""


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    # Migratie voor bestaande databases: class_id-kolom toevoegen.
    cols = [r[1] for r in db.execute("PRAGMA table_info(students)").fetchall()]
    if "class_id" not in cols:
        db.execute(
            "ALTER TABLE students ADD COLUMN class_id INTEGER "
            "REFERENCES classes(id) ON DELETE SET NULL"
        )
    db.commit()
    db.close()


def parse_value(raw):
    """Validate a cell value. Returns normalized value or raises ValueError.

    Accepted: '' (delete), 'V' (voldoende), 'G' (goed), 'VS' (vrijstelling),
    'O' (onvoldoende), or a number between 1 and 10 (comma or point decimal).
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if s == "":
        return ""
    upper = s.upper()
    if upper in ("V", "G", "VS", "O"):
        return upper
    s = s.replace(",", ".")
    try:
        num = float(s)
    except ValueError:
        raise ValueError(f"Ongeldige waarde: {raw!r}")
    if not (1.0 <= num <= 10.0):
        raise ValueError(f"Cijfer moet tussen 1 en 10 liggen: {raw!r}")
    return str(num)


def round_half_up(n):
    return int(math.floor(n + 0.5))


def tekorten_for_value(value):
    """Number of tekorten for a grade value, per the school's rules."""
    if value is None or value == "":
        return 0
    if value in ("V", "G", "VS"):
        return 0
    if value == "O":
        return 1
    try:
        grade = float(value)
    except ValueError:
        return 0
    rounded = round_half_up(grade)
    if rounded < 6:
        return 6 - rounded
    return 0


def display_value(value):
    if value is None or value == "":
        return ""
    if value in ("V", "G", "VS", "O"):
        return value
    try:
        f = float(value)
    except ValueError:
        return value
    if f == int(f):
        return str(int(f))
    return str(f).replace(".", ",")


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------------------------------------------------------------------------
# Classes (klassen met niveau)
# ---------------------------------------------------------------------------

@app.route("/api/classes", methods=["GET", "POST"])
def classes_collection():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        niveau = (data.get("niveau") or "").strip()
        cur = db.execute(
            "INSERT INTO classes (name, niveau) VALUES (?, ?)", (name, niveau)
        )
        db.commit()
        return jsonify(dict(db.execute(
            "SELECT * FROM classes WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM classes ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/classes/<int:class_id>", methods=["PUT", "DELETE"])
def class_item(class_id):
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        niveau = (data.get("niveau") or "").strip()
        db.execute("UPDATE classes SET name = ?, niveau = ? WHERE id = ?",
                   (name, niveau, class_id))
        db.commit()
    else:
        db.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Students
# ---------------------------------------------------------------------------

@app.route("/api/students", methods=["GET", "POST"])
def students_collection():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        number = (data.get("student_number") or "").strip()
        class_id = data.get("class_id") or None
        cur = db.execute(
            "INSERT INTO students (name, student_number, class_id) VALUES (?, ?, ?)",
            (name, number, class_id),
        )
        db.commit()
        return jsonify(dict(db.execute(
            "SELECT * FROM students WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM students ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/students/<int:student_id>", methods=["PUT", "DELETE"])
def student_item(student_id):
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        number = (data.get("student_number") or "").strip()
        class_id = data.get("class_id") or None
        db.execute(
            "UPDATE students SET name = ?, student_number = ?, class_id = ? WHERE id = ?",
            (name, number, class_id, student_id),
        )
        db.commit()
    else:
        db.execute("DELETE FROM students WHERE id = ?", (student_id,))
        db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Subjects
# ---------------------------------------------------------------------------

@app.route("/api/subjects", methods=["GET", "POST"])
def subjects_collection():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        cur = db.execute("INSERT INTO subjects (name) VALUES (?)", (name,))
        db.commit()
        return jsonify(dict(db.execute(
            "SELECT * FROM subjects WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM subjects ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/subjects/<int:subject_id>", methods=["DELETE", "PUT"])
def subject_item(subject_id):
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        db.execute("UPDATE subjects SET name = ? WHERE id = ?", (name, subject_id))
        db.commit()
    else:
        db.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
        db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------

@app.route("/api/periods", methods=["GET", "POST"])
def periods_collection():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        cur = db.execute("INSERT INTO periods (name) VALUES (?)", (name,))
        db.commit()
        return jsonify(dict(db.execute(
            "SELECT * FROM periods WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM periods ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/periods/<int:period_id>", methods=["PUT", "DELETE"])
def period_item(period_id):
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        db.execute("UPDATE periods SET name = ? WHERE id = ?", (name, period_id))
        db.commit()
    else:
        db.execute("DELETE FROM periods WHERE id = ?", (period_id,))
        db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Grades
# ---------------------------------------------------------------------------

@app.route("/api/grades")
def grades_list():
    period_id = request.args.get("period_id", type=int)
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    db = get_db()
    rows = db.execute(
        "SELECT student_id, subject_id, value FROM grades WHERE period_id = ?",
        (period_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/grades", methods=["POST"])
def grade_set():
    data = request.get_json(force=True)
    student_id = data.get("student_id")
    subject_id = data.get("subject_id")
    period_id = data.get("period_id")
    if not (student_id and subject_id and period_id):
        return jsonify({"error": "student_id, subject_id en period_id zijn verplicht"}), 400
    try:
        value = parse_value(data.get("value"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    db = get_db()
    if value == "":
        db.execute(
            "DELETE FROM grades WHERE student_id = ? AND subject_id = ? AND period_id = ?",
            (student_id, subject_id, period_id),
        )
    else:
        db.execute(
            """INSERT INTO grades (student_id, subject_id, period_id, value)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (student_id, subject_id, period_id)
               DO UPDATE SET value = excluded.value""",
            (student_id, subject_id, period_id, value),
        )
    db.commit()
    return jsonify({"ok": True, "value": value,
                    "tekorten": tekorten_for_value(value)})


# ---------------------------------------------------------------------------
# Bulk import (CSV / Excel file or pasted TSV block)
# ---------------------------------------------------------------------------
# Expected table shape (both for files and pasted text):
#   first column: student name or student number
#   header row (optional for paste): first cell ignored, then subject names
#   other cells: grade, V, O or empty
# ---------------------------------------------------------------------------

def table_from_upload(file_storage):
    filename = (file_storage.filename or "").lower()
    if filename.endswith((".xlsx", ".xlsm")):
        wb = openpyxl.load_workbook(file_storage, data_only=True)
        ws = wb.active
        return [[("" if c is None else str(c)) for c in row]
                for row in ws.iter_rows(values_only=True)]
    # CSV / TSV / pasted text
    raw = file_storage.read()
    text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
    return [split_line(line) for line in text.splitlines() if line.strip() != ""]


def split_line(line):
    if "\t" in line:
        return line.split("\t")
    import csv
    delimiter = ";" if ";" in line else ","
    return next(csv.reader([line], delimiter=delimiter))


@app.route("/api/import", methods=["POST"])
def import_grades():
    period_id = request.form.get("period_id", type=int)
    create_missing = request.form.get("create_missing") == "1"
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    file = request.files.get("file")
    if file:
        table = table_from_upload(file)
    else:
        text = request.form.get("text", "")
        table = [split_line(line)
                  for line in text.splitlines() if line.strip() != ""]
    if not table:
        return jsonify({"error": "Geen data gevonden"}), 400

    db = get_db()
    students = {(r["name"].strip().lower(), r["student_number"].strip().lower()): r
                for r in db.execute("SELECT * FROM students").fetchall()}
    students_by_name = {r["name"].strip().lower(): r for r in students.values()}
    students_by_number = {r["student_number"].strip().lower(): r
                          for r in students.values() if r["student_number"]}
    subjects = {r["name"].strip().lower(): r
                for r in db.execute("SELECT * FROM subjects").fetchall()}

    header = table[0]
    # Decide whether the first row is a header (contains subject names).
    first_cell = (header[0] or "").strip().lower()
    header_is_subjects = any(
        (c or "").strip().lower() in subjects for c in header[1:]
    ) or first_cell in ("", "student", "leerling", "naam", "naam student")

    if header_is_subjects:
        subject_cells = header[1:]
        data_rows = table[1:]
    else:
        subject_cells = header[1:]
        data_rows = table

    # Resolve subject columns
    subject_ids = []
    errors = []
    new_subjects = []
    for idx, cell in enumerate(subject_cells):
        name = (cell or "").strip()
        if not name:
            subject_ids.append(None)
            continue
        key = name.lower()
        if key in subjects:
            subject_ids.append(subjects[key]["id"])
        elif create_missing:
            cur = db.execute("INSERT INTO subjects (name) VALUES (?)", (name,))
            db.commit()
            subjects[key] = {"id": cur.lastrowid, "name": name}
            new_subjects.append(name)
            subject_ids.append(cur.lastrowid)
        else:
            errors.append(f"Onbekend vak in kolom {idx + 2}: {name}")
            subject_ids.append(None)

    imported, skipped = 0, 0
    for row in data_rows:
        if not row or not (row[0] or "").strip():
            continue
        ident = row[0].strip()
        key = ident.lower()
        student = (students_by_name.get(key) or students_by_number.get(key))
        if student is None and create_missing:
            cur = db.execute(
                "INSERT INTO students (name, student_number) VALUES (?, ?)",
                (ident, "" if key in students_by_number else ident),
            )
            db.commit()
            student = {"id": cur.lastrowid, "name": ident, "student_number": ""}
            students_by_name[key] = student
        if student is None:
            skipped += 1
            errors.append(f"Onbekende student: {ident}")
            continue
        for j, raw in enumerate(row[1:]):
            if j >= len(subject_ids) or subject_ids[j] is None:
                continue
            try:
                value = parse_value(raw)
            except ValueError as e:
                errors.append(f"{ident}: {e}")
                continue
            if value == "":
                continue
            db.execute(
                """INSERT INTO grades (student_id, subject_id, period_id, value)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (student_id, subject_id, period_id)
                   DO UPDATE SET value = excluded.value""",
                (student["id"], subject_ids[j], period_id, value),
            )
            imported += 1
    db.commit()
    return jsonify({"imported": imported, "skipped": skipped,
                   "new_subjects": new_subjects, "errors": errors[:50]})


# ---------------------------------------------------------------------------
# Import van studenten en vakken (CSV/Excel)
# ---------------------------------------------------------------------------
# Studenten: eerste kolom = naam, daarna optioneel studentnummer en klas.
# Met kopregel worden de kolommen op naam herkend (Naam/Nummer/Klas/Niveau).
# Vakken: eerste kolom = vaknaam.
# Een kopregel (bijv. "Naam,Nummer" of "Vak") wordt automatisch herkend.
# ---------------------------------------------------------------------------

def rows_from_upload(file_storage):
    filename = (file_storage.filename or str()).lower()
    if filename.endswith((".xlsx", ".xlsm")):
        wb = openpyxl.load_workbook(file_storage, data_only=True)
        ws = wb.active
        return [[("" if c is None else str(c).strip()) for c in row]
                for row in ws.iter_rows(values_only=True)]
    raw = file_storage.read()
    text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
    return [split_line(line.strip()) for line in text.splitlines()
            if line.strip() != ""]


@app.route("/api/import/students", methods=["POST"])
def import_students():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Geen bestand meegestuurd"}), 400
    rows = rows_from_upload(file)
    if not rows:
        return jsonify({"error": "Geen data gevonden"}), 400

    name_words = ("naam", "name", "student", "leerling", "studentnaam")
    number_words = ("nummer", "studentnummer", "number", "nr", "id")
    class_words = ("klas", "class", "groep")
    niveau_words = ("niveau", "level")

    header = [c.strip().lower() for c in rows[0]]
    has_header = header and header[0] in name_words
    col = {"name": 0, "number": 1, "class": 2, "niveau": None}
    if has_header:
        for i, h in enumerate(header):
            if h in number_words:
                col["number"] = i
            elif h in class_words:
                col["class"] = i
            elif h in niveau_words:
                col["niveau"] = i
        rows = rows[1:]

    db = get_db()
    classes = {r["name"].strip().lower(): r for r in
               db.execute("SELECT * FROM classes").fetchall()}
    existing = {r["name"].strip().lower() for r in
                db.execute("SELECT name FROM students").fetchall()}
    imported, skipped = 0, 0
    errors = []

    def cell(row, idx):
        return row[idx].strip() if idx is not None and len(row) > idx else ""

    for row in rows:
        if not row or not row[0].strip():
            continue
        name = cell(row, col["name"])
        number = cell(row, col["number"])
        class_name = cell(row, col["class"])
        niveau = cell(row, col["niveau"])
        if not name:
            continue
        class_id = None
        if class_name:
            key = class_name.lower()
            if key not in classes:
                cur = db.execute(
                    "INSERT INTO classes (name, niveau) VALUES (?, ?)",
                    (class_name, niveau),
                )
                db.commit()
                classes[key] = {"id": cur.lastrowid, "name": class_name,
                                "niveau": niveau}
            elif niveau and not classes[key]["niveau"]:
                db.execute("UPDATE classes SET niveau = ? WHERE id = ?",
                           (niveau, classes[key]["id"]))
                db.commit()
            class_id = classes[key]["id"]
        if name.lower() in existing:
            skipped += 1
            continue
        db.execute(
            "INSERT INTO students (name, student_number, class_id) VALUES (?, ?, ?)",
            (name, number, class_id),
        )
        existing.add(name.lower())
        imported += 1
    db.commit()
    return jsonify({"imported": imported, "skipped": skipped,
                     "errors": errors})


@app.route("/api/import/subjects", methods=["POST"])
def import_subjects():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Geen bestand meegestuurd"}), 400
    rows = rows_from_upload(file)
    if not rows:
        return jsonify({"error": "Geen data gevonden"}), 400

    first = rows[0][0].strip().lower()
    if first in ("vak", "vakken", "subject", "subjects", "vaknaam"):
        rows = rows[1:]

    db = get_db()
    existing = {r["name"].strip().lower() for r in
                db.execute("SELECT name FROM subjects").fetchall()}
    imported, skipped = 0, 0
    for row in rows:
        if not row or not row[0].strip():
            continue
        name = row[0].strip()
        if name.lower() in existing:
            skipped += 1
            continue
        db.execute("INSERT INTO subjects (name) VALUES (?)", (name,))
        existing.add(name.lower())
        imported += 1
    db.commit()
    return jsonify({"imported": imported, "skipped": skipped,
                     "errors": []})


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@app.route("/api/report")
def report():
    period_id = request.args.get("period_id", type=int)
    student_id = request.args.get("student_id", type=int)
    class_id = request.args.get("class_id", type=int)
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    db = get_db()
    period = db.execute("SELECT * FROM periods WHERE id = ?", (period_id,)).fetchone()
    if period is None:
        return jsonify({"error": "Periode bestaat niet"}), 404

    if student_id:
        students = db.execute(
            "SELECT * FROM students WHERE id = ?", (student_id,)
        ).fetchall()
    elif class_id:
        students = db.execute(
            "SELECT * FROM students WHERE class_id = ? ORDER BY name", (class_id,)
        ).fetchall()
    else:
        students = db.execute("SELECT * FROM students ORDER BY name").fetchall()

    subjects = db.execute("SELECT * FROM subjects ORDER BY name").fetchall()
    class_map = {}
    for r in db.execute(
        """SELECT st.id AS sid, c.name AS cname, c.niveau AS cniveau
           FROM students st LEFT JOIN classes c ON c.id = st.class_id"""
    ).fetchall():
        class_map[r["sid"]] = (
            {"name": r["cname"], "niveau": r["cniveau"]} if r["cname"] else None
        )
    grades = {}
    for r in db.execute(
        "SELECT student_id, subject_id, value FROM grades WHERE period_id = ?",
        (period_id,),
    ).fetchall():
        grades[(r["student_id"], r["subject_id"])] = r["value"]

    result = []
    for s in students:
        entries = []
        total = 0
        for sub in subjects:
            value = grades.get((s["id"], sub["id"]))
            if value is None:
                continue
            t = tekorten_for_value(value)
            total += t
            entries.append({
                "subject": sub["name"],
                "value": display_value(value),
                "tekorten": t,
            })
        result.append({
            "student": dict(s),
            "class": class_map.get(s["id"]),
            "entries": entries,
            "total_tekorten": total,
        })
    return jsonify({"period": dict(period), "students": result})


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
