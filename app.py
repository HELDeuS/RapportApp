import math
import os
import secrets
import sqlite3
from datetime import timedelta

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import openpyxl

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("RAPPORTAPP_DB", os.path.join(APP_DIR, "rapportapp.db"))

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.permanent_session_lifetime = timedelta(days=7)


def _secret_key():
    keyfile = os.path.join(APP_DIR, ".secret_key")
    if not os.path.exists(keyfile):
        with open(keyfile, "w") as f:
            f.write(secrets.token_hex(32))
    with open(keyfile) as f:
        return f.read().strip()


app.secret_key = _secret_key()

ROLES = ("beheerder", "mentor", "docent", "administratie", "student")


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    row = get_db().execute(
        "SELECT * FROM users WHERE id = ? AND active = 1", (uid,)
    ).fetchone()
    return dict(row) if row else None


def auth_error(*roles):
    """Returns (user, error_response). user is None on success is not possible."""
    user = current_user()
    if user is None:
        return None, (jsonify({"error": "Niet ingelogd"}), 401)
    if roles and user["role"] not in roles:
        return None, (jsonify({"error": "Hiervoor heb je geen toestemming"}), 403)
    return user, None


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
CREATE TABLE IF NOT EXISTS crebos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS cohorts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS leertrajecten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    crebo_id INTEGER REFERENCES crebos(id) ON DELETE SET NULL,
    archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    crebo_id INTEGER REFERENCES crebos(id) ON DELETE SET NULL,
    cohort_id INTEGER REFERENCES cohorts(id) ON DELETE SET NULL,
    mentor_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    student_id INTEGER,
    active INTEGER DEFAULT 1,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    student_number TEXT DEFAULT '',
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    login_enabled INTEGER DEFAULT 0,
    first_name TEXT DEFAULT '',
    prefix TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    assessment_type TEXT DEFAULT 'cijfer'
);
CREATE TABLE IF NOT EXISTS periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    year TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    UNIQUE (student_id, subject_id, period_id)
);
CREATE TABLE IF NOT EXISTS subject_periods (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    UNIQUE (subject_id, period_id)
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    comment TEXT DEFAULT '',
    teacher_comment TEXT DEFAULT '',
    UNIQUE (student_id, period_id)
);
CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    present REAL,
    absent_allowed REAL,
    absent_unallowed REAL,
    UNIQUE (student_id, period_id)
);
CREATE TABLE IF NOT EXISTS subject_classes (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    UNIQUE (subject_id, class_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now', 'localtime')),
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    detail TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS subject_leertrajecten (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    leertraject_id INTEGER NOT NULL REFERENCES leertrajecten(id) ON DELETE CASCADE,
    UNIQUE (subject_id, leertraject_id)
);
"""


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    # Migratie voor bestaande databases: class_id- en year-kolommen toevoegen.
    cols = [r[1] for r in db.execute("PRAGMA table_info(students)").fetchall()]
    if "class_id" not in cols:
        db.execute(
            "ALTER TABLE students ADD COLUMN class_id INTEGER "
            "REFERENCES classes(id) ON DELETE SET NULL"
        )
    pcols = [r[1] for r in db.execute("PRAGMA table_info(periods)").fetchall()]
    if "year" not in pcols:
        db.execute("ALTER TABLE periods ADD COLUMN year TEXT DEFAULT ''")
    # Migratie niveau -> crebo: oude tabel en kolom hernoemen.
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()]
    if "niveaus" in tables:
        db.execute("INSERT OR IGNORE INTO crebos (id, name) "
                   "SELECT id, name FROM niveaus")
        db.execute("DROP TABLE niveaus")
    ccols = [r[1] for r in db.execute("PRAGMA table_info(classes)").fetchall()]
    if "niveau_id" in ccols and "crebo_id" not in ccols:
        db.execute("ALTER TABLE classes RENAME COLUMN niveau_id TO crebo_id")
        ccols = [r[1] for r in db.execute("PRAGMA table_info(classes)").fetchall()]
    if "crebo_id" not in ccols:
        db.execute("ALTER TABLE classes ADD COLUMN crebo_id INTEGER "
                   "REFERENCES crebos(id) ON DELETE SET NULL")
        ccols = [r[1] for r in db.execute("PRAGMA table_info(classes)").fetchall()]
    if "niveau" in ccols:
        for (cname,) in db.execute(
            "SELECT DISTINCT niveau FROM classes "
            "WHERE niveau IS NOT NULL AND niveau != '' "
            "AND crebo_id IS NULL"
        ).fetchall():
            db.execute("INSERT OR IGNORE INTO crebos (name) VALUES (?)", (cname,))
            db.execute(
                "UPDATE classes SET crebo_id = (SELECT id FROM crebos WHERE name = ?) "
                "WHERE niveau = ? AND crebo_id IS NULL", (cname, cname))
    if "cohort_id" not in ccols:
        db.execute("ALTER TABLE classes ADD COLUMN cohort_id INTEGER "
                   "REFERENCES cohorts(id) ON DELETE SET NULL")
    if "leertraject_id" not in ccols:
        db.execute("ALTER TABLE classes ADD COLUMN leertraject_id INTEGER "
                   "REFERENCES leertrajecten(id) ON DELETE SET NULL")
    ltcols = [r[1] for r in db.execute("PRAGMA table_info(leertrajecten)").fetchall()]
    if "cohort_id" not in ltcols:
        db.execute("ALTER TABLE leertrajecten ADD COLUMN cohort_id INTEGER "
                   "REFERENCES cohorts(id) ON DELETE SET NULL")
    # Bestaand startcohort van klassen overzetten naar hun leertraject (idempotent).
    for lt_id, cohort_id in db.execute(
        "SELECT DISTINCT leertraject_id, cohort_id FROM classes "
        "WHERE leertraject_id IS NOT NULL AND cohort_id IS NOT NULL"
    ).fetchall():
        db.execute("UPDATE leertrajecten SET cohort_id = ? "
                   "WHERE id = ? AND cohort_id IS NULL",
                   (cohort_id, lt_id))
    if "mentor_id" not in ccols:
        db.execute("ALTER TABLE classes ADD COLUMN mentor_id INTEGER "
                   "REFERENCES users(id) ON DELETE SET NULL")
    stcols = [r[1] for r in db.execute("PRAGMA table_info(students)").fetchall()]
    if "login_enabled" not in stcols:
        db.execute("ALTER TABLE students ADD COLUMN login_enabled INTEGER DEFAULT 0")
    for col in ("first_name", "prefix", "last_name", "email"):
        if col not in stcols:
            db.execute(f"ALTER TABLE students ADD COLUMN {col} TEXT DEFAULT ''")
    ucols = [r[1] for r in db.execute("PRAGMA table_info(users)").fetchall()]
    if "student_id" not in ucols:
        db.execute("ALTER TABLE users ADD COLUMN student_id INTEGER")
        ucols.append("student_id")
    for col in ("first_name", "last_name", "email"):
        if col not in ucols:
            db.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT DEFAULT ''")
    if not db.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        db.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            ("beheerder", generate_password_hash("rapportapp"), "beheerder"),
        )
    for table in ("students", "classes", "subjects", "cohorts", "leertrajecten"):
        tcols = [r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
        if "archived" not in tcols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN archived INTEGER DEFAULT 0")
    if not db.execute("SELECT COUNT(*) FROM subject_leertrajecten").fetchone()[0]:
        for sub_id, lt_id in db.execute(
            """SELECT DISTINCT sc.subject_id, c.leertraject_id
               FROM subject_classes sc
               JOIN classes c ON c.id = sc.class_id
               WHERE c.leertraject_id IS NOT NULL"""
        ).fetchall():
            db.execute(
                "INSERT OR IGNORE INTO subject_leertrajecten "
                "(subject_id, leertraject_id) VALUES (?, ?)", (sub_id, lt_id))
    scols = [r[1] for r in db.execute("PRAGMA table_info(subjects)").fetchall()]
    if "assessment_type" not in scols:
        db.execute("ALTER TABLE subjects ADD COLUMN assessment_type TEXT DEFAULT 'cijfer'")
        # Bestaande vakken met letterbeoordelingen automatisch op 'letter' zetten.
        db.execute(
            """UPDATE subjects SET assessment_type = 'letter'
               WHERE id IN (
                 SELECT DISTINCT subject_id FROM grades
                 WHERE UPPER(value) IN ('V', 'G', 'O', 'VS')
               )"""
        )
    db.commit()
    db.close()


ASSESSMENT_TYPES = ("cijfer", "letter", "vnv")


def parse_value(raw, assessment_type="cijfer"):
    """Validate a cell value for the subject's assessment type.

    cijfer: number 1-10 (comma or point decimal).
    letter: V (voldoende), G (goed), O (onvoldoende), VS (vrijstelling).
    vnv:    V (voldaan) of NV (niet voldaan).
    Empty string means: delete the grade.
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if s == "":
        return ""
    upper = s.upper()
    if upper == "VS":
        return "VS"
    if assessment_type == "letter":
        if upper in ("V", "G", "VS", "O"):
            return upper
        raise ValueError(
            f"Dit vak wordt met letters beoordeeld (V, G, O of VS): {raw!r}"
        )
    if assessment_type == "vnv":
        if upper == "NV":
            return "NV"
        if upper == "V":
            return "V"
        raise ValueError(f"Dit vak wordt met voldaan/niet voldaan beoordeeld (V of NV): {raw!r}")
    # cijfer
    s2 = s.replace(",", ".")
    try:
        num = float(s2)
    except ValueError:
        raise ValueError(f"Dit vak wordt met cijfers beoordeeld (1 t/m 10): {raw!r}")
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
    if value in ("O", "NV"):
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
# Authenticatie en gebruikersbeheer
# ---------------------------------------------------------------------------

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    row = get_db().execute(
        "SELECT * FROM users WHERE username = ? AND active = 1", (username,)
    ).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "Onjuiste gebruikersnaam of wachtwoord"}), 401
    session.permanent = True
    session["user_id"] = row["id"]
    audit(get_db(), row, "login", "account", row["id"], "Ingelogd")
    return jsonify({"id": row["id"], "username": row["username"],
                    "role": row["role"], "student_id": row["student_id"]})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/me")
def auth_me():
    user = current_user()
    if user is None:
        return jsonify({"error": "Niet ingelogd"}), 401
    return jsonify({"id": user["id"], "username": user["username"],
                    "role": user["role"], "student_id": user["student_id"]})


@app.route("/api/users", methods=["GET", "POST"])
def users_collection():
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        role = data.get("role") or ""
        student_id = data.get("student_id") or None
        if not username or not password:
            return jsonify({"error": "Gebruikersnaam en wachtwoord zijn verplicht"}), 400
        if role not in ROLES:
            return jsonify({"error": "Onbekende rol"}), 400
        if role == "student" and not student_id:
            return jsonify({"error": "Een studentaccount moet aan een student gekoppeld zijn"}), 400
        try:
            cur = db.execute(
                """INSERT INTO users (username, password_hash, role, student_id,
                                      first_name, last_name, email)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (username, generate_password_hash(password), role, student_id,
                 (data.get("first_name") or "").strip(),
                 (data.get("last_name") or "").strip(),
                 (data.get("email") or "").strip()),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "Deze gebruikersnaam bestaat al"}), 400
        audit(db, user, "aanmaken", "gebruiker", cur.lastrowid,
              f"Gebruiker '{username}' met rol {role}")
        return jsonify({"id": cur.lastrowid, "username": username,
                        "role": role, "student_id": student_id}), 201
    rows = db.execute(
        """SELECT u.id, u.username, u.role, u.student_id, u.active,
                  u.first_name, u.last_name, u.email, s.name AS student_name
           FROM users u LEFT JOIN students s ON s.id = u.student_id
           ORDER BY u.username"""
    ).fetchall()
    return jsonify([dict(r) for r in rows])


def would_lose_last_admin(db, user_id, new_role=None, new_active=None):
    """True als deze wijziging de laatste actieve beheerder weghaalt."""
    row = db.execute(
        "SELECT role, active FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None or row["role"] != "beheerder" or not row["active"]:
        return False
    if new_role is not None and new_role != "beheerder":
        return True
    if new_active is not None and not new_active and new_role is None:
        return True
    return False


def last_admin_check(db, user_id, new_role=None, new_active=None):
    if not would_lose_last_admin(db, user_id, new_role, new_active):
        return None
    remaining = db.execute(
        "SELECT COUNT(*) FROM users "
        "WHERE role = 'beheerder' AND active = 1 AND id != ?", (user_id,)
    ).fetchone()[0]
    if remaining == 0:
        return "Dit is de laatste actieve beheerder; wijziging niet toegestaan"
    return None


@app.route("/api/users/<int:user_id>", methods=["PUT", "DELETE"])
def user_item(user_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        if data.get("password"):
            db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                       (generate_password_hash(data["password"]), user_id))
        if "role" in data:
            if data["role"] not in ROLES:
                return jsonify({"error": "Onbekende rol"}), 400
            err = last_admin_check(db, user_id, new_role=data["role"])
            if err:
                return jsonify({"error": err}), 400
            db.execute("UPDATE users SET role = ? WHERE id = ?", (data["role"], user_id))
        if "student_id" in data:
            db.execute("UPDATE users SET student_id = ? WHERE id = ?",
                       (data.get("student_id") or None, user_id))
        for field in ("first_name", "last_name", "email"):
            if field in data:
                db.execute(f"UPDATE users SET {field} = ? WHERE id = ?",
                           ((data.get(field) or "").strip(), user_id))
        if "active" in data:
            if user_id == user["id"] and not data["active"]:
                return jsonify({"error": "Je kunt jezelf niet deactiveren"}), 400
            err = last_admin_check(db, user_id, new_active=data["active"])
            if err:
                return jsonify({"error": err}), 400
            db.execute("UPDATE users SET active = ? WHERE id = ?",
                       (1 if data["active"] else 0, user_id))
        db.commit()
        gewijzigd = [k for k in ("password", "role", "student_id", "first_name",
                                "last_name", "email", "active") if k in data]
        audit(db, user, "wijzigen", "gebruiker", user_id,
              f"Velden: {', '.join(gewijzigd)}")
    else:
        if user_id == user["id"]:
            return jsonify({"error": "Je kunt jezelf niet verwijderen"}), 400
        err = last_admin_check(db, user_id, new_role="")
        if err:
            return jsonify({"error": err}), 400
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        audit(db, user, "verwijderen", "gebruiker", user_id, "")
    return jsonify({"ok": True})


@app.route("/api/admin/reset", methods=["POST"])
def admin_reset():
    """Dummydata-script: leegt alle gegevens, houdt alleen de ingelogde
    beheerder (en het standaardaccount) in stand."""
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    keep = {user["id"]}
    admin = db.execute(
        "SELECT id FROM users WHERE username = 'beheerder' AND role = 'beheerder'"
    ).fetchone()
    if admin:
        keep.add(admin["id"])
    for table in ("grades", "attendance", "notes", "subject_periods",
                 "subject_classes", "subject_leertrajecten",
                 "students", "subjects",
                 "periods", "classes", "cohorts", "crebos", "leertrajecten"):
        db.execute(f"DELETE FROM {table}")
    db.execute("DELETE FROM users WHERE id NOT IN (%s)" % ",".join("?" * len(keep)),
               tuple(keep))
    db.execute("DELETE FROM audit_log")
    db.commit()
    audit(db, user, "reset", "database", None, "Alle gegevens geleegd")
    return jsonify({"ok": True})


def student_display_name(data):
    """Bouw de weergavenaam uit voornaam/tussenvoegsel/achternaam."""
    parts = [data.get("first_name") or "", data.get("prefix") or "", data.get("last_name") or ""]
    return " ".join(p.strip() for p in parts if p and p.strip())


def ensure_student_account(db, student_row):
    """Maakt (of activeert) het studentaccount bij een student; geeft de gebruikersnaam terug."""
    base = (student_row["student_number"] or "").strip() or f"student{student_row['id']}"
    username = base
    n = 0
    while db.execute(
        "SELECT id FROM users WHERE username = ? AND NOT (role = 'student' AND student_id = ?)",
        (username, student_row["id"]),
    ).fetchone():
        n += 1
        username = f"{base}{n}"
    existing = db.execute(
        "SELECT * FROM users WHERE role = 'student' AND student_id = ?",
        (student_row["id"],),
    ).fetchone()
    first = student_row.get("first_name") or ""
    last = student_row.get("last_name") or ""
    email = student_row.get("email") or ""
    if existing is None:
        db.execute(
            """INSERT INTO users (username, password_hash, role, student_id,
                                  first_name, last_name, email)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (username, generate_password_hash("welkom"), "student", student_row["id"],
             first, last, email),
        )
    else:
        db.execute(
            """UPDATE users SET username = ?, active = 1,
                               first_name = ?, last_name = ?, email = ?
               WHERE id = ?""",
            (username, first, last, email, existing["id"]),
        )
    return username


@app.route("/api/auditlog")
def auditlog_list():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    limit = min(request.args.get("limit", type=int) or 500, 2000)
    rows = db.execute(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/users/import", methods=["POST"])
def users_import():
    user, err = auth_error("beheerder")
    if err:
        return err
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Geen bestand meegestuurd"}), 400
    rows = rows_from_upload(file)
    if not rows:
        return jsonify({"error": "Geen data gevonden"}), 400
    header = [c.strip().lower() for c in rows[0]]
    expected = {"gebruikersnaam": "username", "username": "username",
                "wachtwoord": "password", "password": "password",
                "rol": "role", "role": "role",
                "voornaam": "first_name", "first_name": "first_name",
                "achternaam": "last_name", "last_name": "last_name",
                "e-mail": "email", "email": "email", "mail": "email"}
    if any(h in expected for h in header):
        col = {}
        for i, h in enumerate(header):
            if h in expected:
                col[expected[h]] = i
        rows = rows[1:]
    else:
        col = {"username": 0, "password": 1, "role": 2,
               "first_name": 3, "last_name": 4, "email": 5}
    db = get_db()
    imported, skipped, errors = 0, 0, []
    for row in rows:
        if not row or not row[0].strip():
            continue
        def cell(key):
            return row[col[key]].strip() if key in col and len(row) > col[key] else ""
        username = cell("username")
        password = cell("password")
        role = cell("role") or "docent"
        if not username or not password:
            errors.append(f"Rij overgeslagen (geen gebruikersnaam/wachtwoord): {row[:2]}")
            continue
        if role not in ROLES:
            errors.append(f"Onbekende rol '{role}' bij {username}")
            continue
        if db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
            skipped += 1
            continue
        db.execute(
            """INSERT INTO users (username, password_hash, role, first_name, last_name, email)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (username, generate_password_hash(password), role,
             cell("first_name"), cell("last_name"), cell("email")),
        )
        imported += 1
    db.commit()
    audit(db, user, "import", "gebruiker", None,
          f"{imported} gebruiker(s) geïmporteerd, {skipped} overgeslagen")
    return jsonify({"imported": imported, "skipped": skipped, "errors": errors[:50]})


def mentor_class_ids(user):
    if user["role"] != "mentor":
        return None
    rows = get_db().execute(
        "SELECT id FROM classes WHERE mentor_id = ?", (user["id"],)
    ).fetchall()
    return {r["id"] for r in rows}


def mentor_owns_student(user, student_row, new_class_id=None):
    ids = mentor_class_ids(user)
    class_id = new_class_id if new_class_id is not None else student_row["class_id"]
    return class_id in ids if ids is not None else False


def audit(db, user, action, entity, entity_id, detail):
    """Registreer een mutatie in het auditlog; faalt nooit op de hoofdstroom."""
    try:
        db.execute(
            "INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (user["id"], user["username"], action, entity, entity_id, detail))
        db.commit()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Classes (klassen met crebo)
# ---------------------------------------------------------------------------

def class_with_crebo(db, class_id):
    row = db.execute(
        """SELECT c.id, c.name, n.name AS crebo, c.crebo_id,
                  co.name AS cohort, lt.cohort_id,
                  lt.name AS leertraject, c.leertraject_id,
                  c.mentor_id, m.username AS mentor
           FROM classes c
           LEFT JOIN crebos n ON n.id = c.crebo_id
           LEFT JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN cohorts co ON co.id = lt.cohort_id
           LEFT JOIN users m ON m.id = c.mentor_id
           WHERE c.id = ?""",
        (class_id,),
    ).fetchone()
    return dict(row) if row else None


@app.route("/api/cohorts", methods=["GET", "POST"])
def cohorts_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        db.execute("INSERT OR IGNORE INTO cohorts (name) VALUES (?)", (name,))
        db.commit()
        audit(db, user, "aanmaken", "cohort", None, f"Cohort '{name}'")
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        "SELECT * FROM cohorts WHERE archived = ? ORDER BY name DESC", (archived,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/cohorts/<int:cohort_id>", methods=["PUT", "DELETE"])
def cohort_item(cohort_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        archived = 1 if data.get("archived") else 0
        db.execute("UPDATE cohorts SET archived = ? WHERE id = ?", (archived, cohort_id))
        db.commit()
        audit(db, user, "archiveren" if archived else "herstellen", "cohort",
              cohort_id, "")
    else:
        db.execute("DELETE FROM cohorts WHERE id = ?", (cohort_id,))
        db.commit()
        audit(db, user, "verwijderen", "cohort", cohort_id, "")
    return jsonify({"ok": True})


@app.route("/api/crebos", methods=["GET", "POST"])
def crebos_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        db.execute("INSERT OR IGNORE INTO crebos (name) VALUES (?)", (name,))
        db.commit()
        audit(db, user, "aanmaken", "crebo", None, f"Crebo '{name}'")
    rows = db.execute("SELECT * FROM crebos ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/crebos/<int:crebo_id>", methods=["DELETE"])
def crebo_item(crebo_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    db.execute("DELETE FROM crebos WHERE id = ?", (crebo_id,))
    db.commit()
    audit(db, user, "verwijderen", "crebo", crebo_id, "")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Leertrajecten (onder een crebo, met gekoppelde modules)
# ---------------------------------------------------------------------------

def leertraject_with_periods(db, row):
    return dict(row)


@app.route("/api/leertrajecten", methods=["GET", "POST"])
def leertrajecten_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        crebo_id = data.get("crebo_id") or None
        cohort_id = data.get("cohort_id") or None
        cur = db.execute(
            "INSERT INTO leertrajecten (name, crebo_id, cohort_id) VALUES (?, ?, ?)",
            (name, crebo_id, cohort_id))
        db.commit()
        audit(db, user, "aanmaken", "leertraject", cur.lastrowid,
              f"Leertraject '{name}'")
        row = db.execute("SELECT * FROM leertrajecten WHERE id = ?",
                         (cur.lastrowid,)).fetchone()
        return jsonify(leertraject_with_periods(db, row)), 201
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        """SELECT lt.*, n.name AS crebo, co.name AS cohort
           FROM leertrajecten lt
           LEFT JOIN crebos n ON n.id = lt.crebo_id
           LEFT JOIN cohorts co ON co.id = lt.cohort_id
           WHERE lt.archived = ? ORDER BY lt.name""",
        (archived,)).fetchall()
    return jsonify([leertraject_with_periods(db, r) for r in rows])


@app.route("/api/leertrajecten/<int:lt_id>", methods=["PUT", "DELETE"])
def leertraject_item(lt_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        updates = {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Naam is verplicht"}), 400
            updates["name"] = name
        if "crebo_id" in data:
            updates["crebo_id"] = data.get("crebo_id") or None
        if "cohort_id" in data:
            updates["cohort_id"] = data.get("cohort_id") or None
        if "archived" in data:
            updates["archived"] = 1 if data.get("archived") else 0
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            db.execute(f"UPDATE leertrajecten SET {sets} WHERE id = ?",
                       (*updates.values(), lt_id))
        db.commit()
        gewijzigd = [k for k in ("name", "crebo_id", "cohort_id", "archived")
                     if k in data]
        audit(db, user, "wijzigen", "leertraject", lt_id,
              f"Velden: {', '.join(gewijzigd)}" if gewijzigd else "")
        row = db.execute("SELECT * FROM leertrajecten WHERE id = ?", (lt_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Leertraject niet gevonden"}), 404
        return jsonify(leertraject_with_periods(db, row))
    db.execute("DELETE FROM leertrajecten WHERE id = ?", (lt_id,))
    db.commit()
    audit(db, user, "verwijderen", "leertraject", lt_id, "")
    return jsonify({"ok": True})


@app.route("/api/classes", methods=["GET", "POST"])
def classes_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        crebo_id = data.get("crebo_id") or None
        mentor_id = data.get("mentor_id") or None
        leertraject_id = data.get("leertraject_id") or None
        cur = db.execute(
            "INSERT INTO classes (name, crebo_id, leertraject_id, mentor_id) "
            "VALUES (?, ?, ?, ?)",
            (name, crebo_id, leertraject_id, mentor_id),
        )
        db.commit()
        audit(db, user, "aanmaken", "klas", cur.lastrowid, f"Klas '{name}'")
        return jsonify(class_with_crebo(db, cur.lastrowid)), 201
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        """SELECT c.id, c.name, n.name AS crebo, c.crebo_id,
                  co.name AS cohort, lt.cohort_id, c.archived,
                  lt.name AS leertraject, c.leertraject_id,
                  c.mentor_id, m.username AS mentor
           FROM classes c
           LEFT JOIN crebos n ON n.id = c.crebo_id
           LEFT JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN cohorts co ON co.id = lt.cohort_id
           LEFT JOIN users m ON m.id = c.mentor_id
           WHERE c.archived = ?
           ORDER BY c.name""",
        (archived,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/classes/<int:class_id>", methods=["PUT", "DELETE"])
def class_item(class_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        updates = {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Naam is verplicht"}), 400
            updates["name"] = name
        if "crebo_id" in data:
            updates["crebo_id"] = data.get("crebo_id") or None
        if "leertraject_id" in data:
            updates["leertraject_id"] = data.get("leertraject_id") or None
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            db.execute(f"UPDATE classes SET {sets} WHERE id = ?",
                       (*updates.values(), class_id))
        if "mentor_id" in data:
            db.execute("UPDATE classes SET mentor_id = ? WHERE id = ?",
                       (data.get("mentor_id") or None, class_id))
        if "archived" in data:
            db.execute("UPDATE classes SET archived = ? WHERE id = ?",
                       (1 if data.get("archived") else 0, class_id))
        db.commit()
        gewijzigd = [k for k in ("name", "crebo_id", "leertraject_id",
                                 "mentor_id", "archived") if k in data]
        audit(db, user, "wijzigen", "klas", class_id,
              f"Velden: {', '.join(gewijzigd)}" if gewijzigd else "")
    else:
        db.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        db.commit()
        audit(db, user, "verwijderen", "klas", class_id, "")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Students
# ---------------------------------------------------------------------------

@app.route("/api/students", methods=["GET", "POST"])
def students_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder", "mentor")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        number = (data.get("student_number") or "").strip()
        first = (data.get("first_name") or "").strip()
        last = (data.get("last_name") or "").strip()
        email = (data.get("email") or "").strip()
        if not number:
            return jsonify({"error": "Studentnummer is verplicht"}), 400
        if not first:
            return jsonify({"error": "Voornaam is verplicht"}), 400
        if not last:
            return jsonify({"error": "Achternaam is verplicht"}), 400
        if not email:
            return jsonify({"error": "E-mailadres is verplicht"}), 400
        prefix = (data.get("prefix") or "").strip()
        name = student_display_name({"first_name": first, "prefix": prefix, "last_name": last})
        class_id = data.get("class_id") or None
        if user["role"] == "mentor" and not mentor_owns_student(user, None, class_id):
            return jsonify({"error": "Als mentor kun je alleen studenten in je eigen klas toevoegen"}), 403
        cur = db.execute(
            """INSERT INTO students (name, student_number, class_id, login_enabled,
                                     first_name, prefix, last_name, email)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, number, class_id, 1 if data.get("login_enabled") else 0,
             first, prefix, last, email),
        )
        db.commit()
        student = dict(db.execute(
            "SELECT * FROM students WHERE id = ?", (cur.lastrowid,)
        ).fetchone())
        username = None
        if data.get("login_enabled"):
            username = ensure_student_account(db, student)
            db.commit()
        student["login_username"] = username
        audit(db, user, "aanmaken", "student", cur.lastrowid,
              f"Student '{name}' ({number})")
        return jsonify(student), 201
    archived = 1 if request.args.get("archived") == "1" else 0
    mentor_ids = None
    if user["role"] == "mentor":
        mentor_ids = mentor_class_ids(user)
    if mentor_ids is not None:
        if not mentor_ids:
            return jsonify([])
        placeholders = ",".join("?" for _ in mentor_ids)
        rows = db.execute(
            f"""SELECT st.*, u.username AS login_username, u.active AS login_active
                FROM students st
                LEFT JOIN users u ON u.student_id = st.id AND u.role = 'student'
                WHERE st.archived = ? AND st.class_id IN ({placeholders})
                ORDER BY st.name""",
            (archived, *mentor_ids),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT st.*, u.username AS login_username, u.active AS login_active
               FROM students st
               LEFT JOIN users u ON u.student_id = st.id AND u.role = 'student'
               WHERE st.archived = ?
               ORDER BY st.name""",
            (archived,),
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/students/bulk", methods=["POST"])
def students_bulk():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    action = data.get("action")
    if not ids or action not in ("login_on", "login_off", "archive", "unarchive", "delete"):
        return jsonify({"error": "Ongeldig bulkverzoek"}), 400
    user, err = auth_error("beheerder") if action == "delete" else auth_error("beheerder", "mentor")
    if err:
        return err
    db = get_db()
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT * FROM students WHERE id IN ({placeholders})", ids
    ).fetchall()
    if user["role"] == "mentor":
        own = mentor_class_ids(user)
        rows = [r for r in rows if r["class_id"] in own]
    usernames = []
    for r in rows:
        if action == "delete":
            db.execute("DELETE FROM students WHERE id = ?", (r["id"],))
        elif action == "archive":
            db.execute("UPDATE students SET archived = 1 WHERE id = ?", (r["id"],))
        elif action == "unarchive":
            db.execute("UPDATE students SET archived = 0 WHERE id = ?", (r["id"],))
        elif action == "login_on":
            db.execute("UPDATE students SET login_enabled = 1 WHERE id = ?", (r["id"],))
            usernames.append(ensure_student_account(db, dict(r)))
        elif action == "login_off":
            db.execute("UPDATE students SET login_enabled = 0 WHERE id = ?", (r["id"],))
            db.execute("UPDATE users SET active = 0 WHERE role = 'student' AND student_id = ?",
                       (r["id"],))
    db.commit()
    audit(db, user, "bulk-" + action, "student", None,
          f"{len(rows)} student(en): {action}")
    return jsonify({"ok": True, "affected": len(rows), "usernames": usernames})


@app.route("/api/students/<int:student_id>", methods=["PUT", "DELETE"])
def student_item(student_id):
    user, err = auth_error("beheerder", "mentor") if request.method == "PUT" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        existing = db.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
        if existing is None:
            return jsonify({"error": "Student bestaat niet"}), 404
        if user["role"] == "mentor":
            target_class = data.get("class_id", existing["class_id"]) or None
            if not mentor_owns_student(user, existing, target_class):
                return jsonify({"error": "Als mentor kun je alleen studenten van je eigen klas wijzigen"}), 403
            if "class_id" in data and (data.get("class_id") or None) not in mentor_class_ids(user):
                return jsonify({"error": "Als mentor kun je studenten niet naar een andere klas verplaatsen"}), 403
        updates = {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Naam is verplicht"}), 400
            updates["name"] = name
        if "student_number" in data:
            updates["student_number"] = (data.get("student_number") or "").strip()
        if "class_id" in data:
            updates["class_id"] = data.get("class_id") or None
        for field in ("first_name", "prefix", "last_name", "email"):
            if field in data:
                updates[field] = (data.get(field) or "").strip()
        if "name" not in updates and any(k in updates for k in ("first_name", "prefix", "last_name")):
            merged = dict(existing)
            merged.update(updates)
            new_name = student_display_name(merged)
            if new_name:
                updates["name"] = new_name
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            db.execute(f"UPDATE students SET {sets} WHERE id = ?",
                       (*updates.values(), student_id))
        if "login_enabled" in data:
            enable = 1 if data.get("login_enabled") else 0
            db.execute("UPDATE students SET login_enabled = ? WHERE id = ?",
                       (enable, student_id))
            db.commit()
            if enable:
                fresh = db.execute(
                    "SELECT * FROM students WHERE id = ?", (student_id,)
                ).fetchone()
                username = ensure_student_account(db, dict(fresh))
                db.commit()
                return jsonify({"ok": True, "login_username": username})
            db.execute(
                "UPDATE users SET active = 0 WHERE role = 'student' AND student_id = ?",
                (student_id,),
            )
        if "archived" in data:
            db.execute("UPDATE students SET archived = ? WHERE id = ?",
                       (1 if data.get("archived") else 0, student_id))
        db.commit()
        gewijzigd = [k for k in ("name", "student_number", "class_id", "first_name",
                                 "prefix", "last_name", "email", "login_enabled",
                                 "archived") if k in data]
        audit(db, user, "wijzigen", "student", student_id,
              f"Velden: {', '.join(gewijzigd)}" if gewijzigd else "")
    else:
        db.execute("DELETE FROM students WHERE id = ?", (student_id,))
        db.commit()
        audit(db, user, "verwijderen", "student", student_id, "")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Subjects
# ---------------------------------------------------------------------------

def subject_with_periods(db, subject_id):
    row = db.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()
    if row is None:
        return None
    result = dict(row)
    result["assessment_type"] = result.get("assessment_type") or "cijfer"
    result["period_ids"] = [
        r["period_id"] for r in db.execute(
            "SELECT period_id FROM subject_periods WHERE subject_id = ? ORDER BY period_id",
            (subject_id,),
        ).fetchall()
    ]
    result["leertraject_ids"] = [
        r["leertraject_id"] for r in db.execute(
            "SELECT leertraject_id FROM subject_leertrajecten "
            "WHERE subject_id = ? ORDER BY leertraject_id",
            (subject_id,),
        ).fetchall()
    ]
    return result


@app.route("/api/subjects", methods=["GET", "POST"])
def subjects_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie") if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        period_ids = data.get("period_ids") or []
        leertraject_ids = data.get("leertraject_ids") or []
        assessment_type = data.get("assessment_type") or "cijfer"
        if assessment_type not in ASSESSMENT_TYPES:
            return jsonify({"error": "Onbekend beoordelingstype"}), 400
        cur = db.execute(
            "INSERT INTO subjects (name, assessment_type) VALUES (?, ?)",
            (name, assessment_type),
        )
        subject_id = cur.lastrowid
        for pid in period_ids:
            db.execute(
                "INSERT OR IGNORE INTO subject_periods (subject_id, period_id) VALUES (?, ?)",
                (subject_id, pid),
            )
        for ltid in leertraject_ids:
            db.execute(
                "INSERT OR IGNORE INTO subject_leertrajecten "
                "(subject_id, leertraject_id) VALUES (?, ?)",
                (subject_id, ltid),
            )
        db.commit()
        audit(db, user, "aanmaken", "vak", subject_id,
              f"Vak '{name}' ({assessment_type})")
        return jsonify(subject_with_periods(db, subject_id)), 201
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        "SELECT * FROM subjects WHERE archived = ? ORDER BY name", (archived,)
    ).fetchall()
    return jsonify([subject_with_periods(db, r["id"]) for r in rows])


@app.route("/api/subjects/<int:subject_id>", methods=["DELETE", "PUT"])
def subject_item(subject_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if "name" in data and not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        if name:
            db.execute("UPDATE subjects SET name = ? WHERE id = ?", (name, subject_id))
        if "period_ids" in data:
            db.execute("DELETE FROM subject_periods WHERE subject_id = ?", (subject_id,))
            for pid in (data.get("period_ids") or []):
                db.execute(
                    "INSERT OR IGNORE INTO subject_periods (subject_id, period_id) VALUES (?, ?)",
                    (subject_id, pid),
                )
        if "leertraject_ids" in data:
            db.execute("DELETE FROM subject_leertrajecten WHERE subject_id = ?",
                       (subject_id,))
            for ltid in (data.get("leertraject_ids") or []):
                db.execute(
                    "INSERT OR IGNORE INTO subject_leertrajecten "
                    "(subject_id, leertraject_id) VALUES (?, ?)",
                    (subject_id, ltid),
                )
        if "assessment_type" in data:
            assessment_type = data.get("assessment_type") or "cijfer"
            if assessment_type not in ASSESSMENT_TYPES:
                return jsonify({"error": "Onbekend beoordelingstype"}), 400
            db.execute("UPDATE subjects SET assessment_type = ? WHERE id = ?",
                       (assessment_type, subject_id))
        if "archived" in data:
            db.execute("UPDATE subjects SET archived = ? WHERE id = ?",
                       (1 if data.get("archived") else 0, subject_id))
        db.commit()
        gewijzigd = [k for k in ("name", "period_ids", "leertraject_ids",
                                 "assessment_type", "archived") if k in data]
        audit(db, user, "wijzigen", "vak", subject_id,
              f"Velden: {', '.join(gewijzigd)}" if gewijzigd else "")
    else:
        db.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
        db.commit()
        audit(db, user, "verwijderen", "vak", subject_id, "")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------

@app.route("/api/periods", methods=["GET", "POST"])
def periods_collection():
    user, err = auth_error() if request.method == "GET" else auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        year = (data.get("year") or "").strip()
        cur = db.execute("INSERT INTO periods (name, year) VALUES (?, ?)", (name, year))
        db.commit()
        audit(db, user, "aanmaken", "module", cur.lastrowid,
              f"Module '{name}' ({year})" if year else f"Module '{name}'")
        return jsonify(dict(db.execute(
            "SELECT * FROM periods WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM periods ORDER BY year, id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/periods/<int:period_id>", methods=["PUT", "DELETE"])
def period_item(period_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Naam is verplicht"}), 400
        year = (data.get("year") if "year" in data else None)
        if year is None:
            db.execute("UPDATE periods SET name = ? WHERE id = ?", (name, period_id))
        else:
            db.execute("UPDATE periods SET name = ?, year = ? WHERE id = ?",
                       (name, year.strip(), period_id))
        db.commit()
        audit(db, user, "wijzigen", "module", period_id, f"Module '{name}'")
    else:
        db.execute("DELETE FROM periods WHERE id = ?", (period_id,))
        db.commit()
        audit(db, user, "verwijderen", "module", period_id, "")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Grades
# ---------------------------------------------------------------------------

@app.route("/api/grades")
def grades_list():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
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
    user, err = auth_error("beheerder", "docent")
    if err:
        return err
    data = request.get_json(force=True)
    student_id = data.get("student_id")
    subject_id = data.get("subject_id")
    period_id = data.get("period_id")
    if not (student_id and subject_id and period_id):
        return jsonify({"error": "student_id, subject_id en period_id zijn verplicht"}), 400
    db = get_db()
    subject = db.execute(
        "SELECT assessment_type FROM subjects WHERE id = ?", (subject_id,)
    ).fetchone()
    assessment_type = (subject["assessment_type"] if subject else None) or "cijfer"
    try:
        value = parse_value(data.get("value"), assessment_type)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
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
    audit(db, user, "cijfer", "student", student_id,
          f"Vak #{subject_id}, module #{period_id}: "
          f"{'verwijderd' if value == '' else value}")
    return jsonify({"ok": True, "value": value,
                    "tekorten": tekorten_for_value(value)})


@app.route("/api/grades/bulk", methods=["POST"])
def grade_bulk():
    """Kolom-import: één vak, meerdere studenten (geplakte kolom uit Excel)."""
    user, err = auth_error("beheerder", "docent")
    if err:
        return err
    data = request.get_json(force=True)
    subject_id = data.get("subject_id")
    period_id = data.get("period_id")
    entries = data.get("entries") or []
    if not (subject_id and period_id):
        return jsonify({"error": "subject_id en period_id zijn verplicht"}), 400
    db = get_db()
    subject = db.execute(
        "SELECT assessment_type, name FROM subjects WHERE id = ?", (subject_id,)
    ).fetchone()
    if subject is None:
        return jsonify({"error": "Onbekend vak"}), 400
    imported, errors = 0, []
    for entry in entries:
        student_id = entry.get("student_id")
        if not student_id:
            continue
        try:
            value = parse_value(entry.get("value"), subject["assessment_type"])
        except ValueError as e:
            errors.append(str(e))
            continue
        if value == "":
            continue
        db.execute(
            """INSERT INTO grades (student_id, subject_id, period_id, value)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (student_id, subject_id, period_id)
               DO UPDATE SET value = excluded.value""",
            (student_id, subject_id, period_id, value),
        )
        imported += 1
    db.commit()
    audit(db, user, "cijfers-kolom", "vak", subject_id,
          f"{imported} cijfer(s) voor module #{period_id}"
          + (f"; fouten: {'; '.join(errors[:3])}" if errors else ""))
    return jsonify({"ok": True, "imported": imported, "errors": errors[:50]})


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
    user, err = auth_error("beheerder", "docent")
    if err:
        return err
    period_id = request.form.get("period_id", type=int)
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
    subject_types = []
    errors = []
    for idx, cell in enumerate(subject_cells):
        name = (cell or "").strip()
        if not name:
            subject_ids.append(None)
            subject_types.append("cijfer")
            continue
        key = name.lower()
        if key in subjects:
            subject_ids.append(subjects[key]["id"])
        else:
            errors.append(f"Onbekend vak in kolom {idx + 2}: {name}")
            subject_ids.append(None)
        subject_types.append(
            db.execute("SELECT assessment_type FROM subjects WHERE id = ?",
                       (subject_ids[-1],)).fetchone()["assessment_type"]
            if subject_ids[-1] else "cijfer"
        )

    imported, skipped = 0, 0
    for row in data_rows:
        if not row or not (row[0] or "").strip():
            continue
        ident = row[0].strip()
        key = ident.lower()
        student = (students_by_name.get(key) or students_by_number.get(key))
        if student is None:
            skipped += 1
            errors.append(f"Onbekende student: {ident}")
            continue
        for j, raw in enumerate(row[1:]):
            if j >= len(subject_ids) or subject_ids[j] is None:
                continue
            try:
                value = parse_value(raw, subject_types[j])
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
    audit(db, user, "import", "cijfers", None,
          f"{imported} cijfer(s) geïmporteerd, {skipped} overgeslagen, "
          f"{len(errors)} foutmelding(en) voor module #{period_id}")
    return jsonify({"imported": imported, "skipped": skipped,
                   "errors": errors[:50]})


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
    user, err = auth_error("beheerder")
    if err:
        return err
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Geen bestand meegestuurd"}), 400
    rows = rows_from_upload(file)
    if not rows:
        return jsonify({"error": "Geen data gevonden"}), 400

    name_words = ("naam", "name", "student", "leerling", "studentnaam")
    number_words = ("nummer", "studentnummer", "number", "nr", "id")
    class_words = ("klas", "class", "groep")
    crebo_words = ("crebo", "niveau", "level")
    first_words = ("voornaam", "voornamen", "first", "first name")
    prefix_words = ("tussenvoegsel", "tussenvoegsels", "prefix", "voorvoegsel")
    last_words = ("achternaam", "achternamen", "last", "last name", "familienaam")
    email_words = ("email", "e-mail", "mail", "mailadres", "e-mailadres")

    header = [c.strip().lower() for c in rows[0]]
    has_header = header and (header[0] in name_words or header[0] in first_words
                              or header[0] in number_words)
    col = {"name": 0, "number": 1, "class": 2, "crebo": None,
           "first": None, "prefix": None, "last": None, "email": None}
    if has_header:
        for i, h in enumerate(header):
            if h in number_words:
                col["number"] = i
            elif h in class_words:
                col["class"] = i
            elif h in crebo_words:
                col["crebo"] = i
            elif h in first_words:
                col["first"] = i
            elif h in prefix_words:
                col["prefix"] = i
            elif h in last_words:
                col["last"] = i
            elif h in email_words:
                col["email"] = i
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
        first = cell(row, col["first"])
        prefix = cell(row, col["prefix"])
        last = cell(row, col["last"])
        email = cell(row, col["email"])
        name = student_display_name({"first_name": first, "prefix": prefix, "last_name": last})             if col["first"] is not None or col["last"] is not None             else cell(row, col["name"])
        if not name:
            continue
        number = cell(row, col["number"])
        class_name = cell(row, col["class"])
        niveau = cell(row, col["crebo"])
        if not name:
            continue
        class_id = None
        if class_name:
            key = class_name.lower()
            if key not in classes:
                crebo_id = None
                if niveau:
                    db.execute("INSERT OR IGNORE INTO crebos (name) VALUES (?)",
                               (niveau,))
                    db.commit()
                    crebo_id = db.execute(
                        "SELECT id FROM crebos WHERE name = ?", (niveau,)
                    ).fetchone()["id"]
                cur = db.execute(
                    "INSERT INTO classes (name, crebo_id) VALUES (?, ?)",
                    (class_name, crebo_id),
                )
                db.commit()
                classes[key] = {"id": cur.lastrowid, "name": class_name,
                                "crebo_id": crebo_id}
            elif niveau and not classes[key].get("crebo_id"):
                db.execute("INSERT OR IGNORE INTO crebos (name) VALUES (?)",
                           (niveau,))
                db.commit()
                nrow = db.execute("SELECT id FROM crebos WHERE name = ?",
                                  (niveau,)).fetchone()
                db.execute("UPDATE classes SET crebo_id = ? WHERE id = ?",
                           (nrow["id"], classes[key]["id"]))
                db.commit()
                classes[key]["crebo_id"] = nrow["id"]
            class_id = classes[key]["id"]
        if name.lower() in existing:
            skipped += 1
            continue
        db.execute(
            """INSERT INTO students (name, student_number, class_id,
                                     first_name, prefix, last_name, email)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, number, class_id, first, prefix, last, email),
        )
        existing.add(name.lower())
        imported += 1
    db.commit()
    audit(db, user, "import", "student", None,
          f"{imported} student(en) geïmporteerd, {skipped} overgeslagen")
    return jsonify({"imported": imported, "skipped": skipped,
                     "errors": errors})


@app.route("/api/import/subjects", methods=["POST"])
def import_subjects():
    user, err = auth_error("beheerder")
    if err:
        return err
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
    audit(db, user, "import", "vak", None,
          f"{imported} vak(ken) geïmporteerd, {skipped} overgeslagen")
    return jsonify({"imported": imported, "skipped": skipped,
                     "errors": []})


# ---------------------------------------------------------------------------
# Opmerkingen (per student per module)
# ---------------------------------------------------------------------------

@app.route("/api/notes")
def notes_list():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    period_id = request.args.get("period_id", type=int)
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    db = get_db()
    rows = db.execute(
        """SELECT student_id, comment, teacher_comment FROM notes
           WHERE period_id = ? AND (comment != '' OR teacher_comment != '')""",
        (period_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/notes", methods=["POST"])
def note_set():
    user, err = auth_error("beheerder", "docent", "mentor")
    if err:
        return err
    data = request.get_json(force=True)
    student_id = data.get("student_id")
    period_id = data.get("period_id")
    if not (student_id and period_id):
        return jsonify({"error": "student_id en period_id zijn verplicht"}), 400
    comment = (data.get("comment") or "").strip()
    teacher_comment = (data.get("teacher_comment") or "").strip()
    db = get_db()
    if comment == "" and teacher_comment == "":
        db.execute("DELETE FROM notes WHERE student_id = ? AND period_id = ?",
                   (student_id, period_id))
    else:
        db.execute(
            """INSERT INTO notes (student_id, period_id, comment, teacher_comment)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (student_id, period_id) DO UPDATE SET
                 comment = excluded.comment,
                 teacher_comment = excluded.teacher_comment""",
            (student_id, period_id, comment, teacher_comment),
        )
    db.commit()
    audit(db, user, "opmerkingen", "student", student_id,
          f"Opmerkingen voor module #{period_id} "
          + ("verwijderd" if not comment and not teacher_comment else "opgeslagen"))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Aanwezigheid (per student per module, percentages)
# ---------------------------------------------------------------------------

def parse_percent(raw):
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip().rstrip("%").replace(",", ".")
    try:
        num = float(s)
    except ValueError:
        raise ValueError(f"Ongeldig percentage: {raw!r}")
    if not (0.0 <= num <= 100.0):
        raise ValueError(f"Percentage moet tussen 0 en 100 liggen: {raw!r}")
    return num


@app.route("/api/attendance")
def attendance_list():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    period_id = request.args.get("period_id", type=int)
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    db = get_db()
    rows = db.execute(
        """SELECT student_id, present, absent_allowed, absent_unallowed
           FROM attendance WHERE period_id = ?""",
        (period_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/attendance", methods=["POST"])
def attendance_set():
    user, err = auth_error("beheerder", "docent", "mentor")
    if err:
        return err
    data = request.get_json(force=True)
    student_id = data.get("student_id")
    period_id = data.get("period_id")
    if not (student_id and period_id):
        return jsonify({"error": "student_id en period_id zijn verplicht"}), 400
    try:
        present = parse_percent(data.get("present"))
        allowed = parse_percent(data.get("absent_allowed"))
        unallowed = parse_percent(data.get("absent_unallowed"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if present is not None or allowed is not None or unallowed is not None:
        total = (present or 0) + (allowed or 0) + (unallowed or 0)
        if abs(total - 100.0) > 0.01:
            return jsonify({
                "error": (f"Aanwezigheid ({present or 0}%) + geoorloofd afwezig "
                          f"({allowed or 0}%) + ongeoorloofd afwezig "
                          f"({unallowed or 0}%) = {total}% — samen moet dit 100% zijn.")
            }), 400
    db = get_db()
    if present is None and allowed is None and unallowed is None:
        db.execute("DELETE FROM attendance WHERE student_id = ? AND period_id = ?",
                   (student_id, period_id))
    else:
        db.execute(
            """INSERT INTO attendance (student_id, period_id, present, absent_allowed, absent_unallowed)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (student_id, period_id) DO UPDATE SET
                 present = excluded.present,
                 absent_allowed = excluded.absent_allowed,
                 absent_unallowed = excluded.absent_unallowed""",
            (student_id, period_id, present, allowed, unallowed),
        )
    db.commit()
    audit(db, user, "aanwezigheid", "student", student_id,
          f"Aanwezigheid module #{period_id}: "
          f"{present or 0}% / {allowed or 0}% / {unallowed or 0}%")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@app.route("/api/report")
def report():
    user, err = auth_error()
    if err:
        return err
    period_id = request.args.get("period_id", type=int)
    student_id = request.args.get("student_id", type=int)
    if user["role"] == "student":
        if not user.get("student_id"):
            return jsonify({"error": "Dit account is niet aan een student gekoppeld"}), 403
        student_id = user["student_id"]
        class_id = None
        cohort_id = None
    else:
        class_id = request.args.get("class_id", type=int)
        cohort_id = request.args.get("cohort_id", type=int)
    class_id = request.args.get("class_id", type=int)
    cohort_id = request.args.get("cohort_id", type=int)
    if not period_id:
        return jsonify({"error": "period_id is verplicht"}), 400
    db = get_db()
    period = db.execute("SELECT * FROM periods WHERE id = ?", (period_id,)).fetchone()
    if period is None:
        return jsonify({"error": "Periode bestaat niet"}), 404

    if student_id:
        students = db.execute(
            "SELECT * FROM students WHERE id = ? AND archived = 0", (student_id,)
        ).fetchall()
    elif cohort_id:
        students = db.execute(
            """SELECT st.* FROM students st
               JOIN classes c ON c.id = st.class_id
               JOIN leertrajecten lt ON lt.id = c.leertraject_id
               JOIN cohorts co ON co.id = lt.cohort_id
               WHERE lt.cohort_id = ? AND st.archived = 0
                 AND co.archived = 0
               ORDER BY st.name""",
            (cohort_id,),
        ).fetchall()
    elif class_id:
        students = db.execute(
            """SELECT st.* FROM students st
               JOIN classes c ON c.id = st.class_id
               WHERE st.class_id = ? AND st.archived = 0 AND c.archived = 0
               ORDER BY st.name""",
            (class_id,),
        ).fetchall()
    else:
        students = db.execute(
            "SELECT * FROM students WHERE archived = 0 ORDER BY name"
        ).fetchall()

    subjects = db.execute(
        "SELECT * FROM subjects WHERE archived = 0 ORDER BY name"
    ).fetchall()
    # Alleen vakken tonen waarvan de periode expliciet is aangevinkt.
    subject_period_map = {}
    for r in db.execute("SELECT subject_id, period_id FROM subject_periods").fetchall():
        subject_period_map.setdefault(r["subject_id"], set()).add(r["period_id"])
    subjects = [s for s in subjects
                if period_id in subject_period_map.get(s["id"], set())]
    # Vak-klasse-koppeling: alleen vakken waarvan de klas is aangevinkt.
    # Bepaal per student de relevante klas (of de geselecteerde klas van het rapport).
    subject_lt_map = {}
    for r in db.execute(
        "SELECT subject_id, leertraject_id FROM subject_leertrajecten"
    ).fetchall():
        subject_lt_map.setdefault(r["subject_id"], set()).add(r["leertraject_id"])
    class_lt_map = {}
    for r in db.execute(
        "SELECT id, leertraject_id FROM classes WHERE leertraject_id IS NOT NULL"
    ).fetchall():
        class_lt_map[r["id"]] = r["leertraject_id"]
    class_map = {}
    for r in db.execute(
        """SELECT st.id AS sid, c.name AS cname, n.name AS ccrebo
           FROM students st
           LEFT JOIN classes c ON c.id = st.class_id
           LEFT JOIN crebos n ON n.id = c.crebo_id"""
    ).fetchall():
        class_map[r["sid"]] = (
            {"name": r["cname"], "crebo": r["ccrebo"]} if r["cname"] else None
        )
    audience = "student" if user["role"] == "student" else request.args.get("audience", "staff")
    notes_map = {}
    for r in db.execute(
        """SELECT student_id, comment, teacher_comment FROM notes
           WHERE period_id = ?""",
        (period_id,),
    ).fetchall():
        notes_map[r["student_id"]] = {
            "comment": r["comment"],
            "teacher_comment": r["teacher_comment"] if audience != "student" else "",
        }
    attendance = {}
    for r in db.execute(
        """SELECT student_id, present, absent_allowed, absent_unallowed
           FROM attendance WHERE period_id = ?""",
        (period_id,),
    ).fetchall():
        attendance[r["student_id"]] = {
            "present": r["present"],
            "absent_allowed": r["absent_allowed"],
            "absent_unallowed": r["absent_unallowed"],
        }
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
        student_class = s["class_id"] if "class_id" in s.keys() else None
        if student_class is None and class_id:
            student_class = class_id
        student_lt = (class_lt_map.get(student_class)
                      if student_class is not None else None)
        for sub in subjects:
            if student_lt is not None:
                allowed = subject_lt_map.get(sub["id"], set())
                if allowed and student_lt not in allowed:
                    continue
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
        att = attendance.get(s["id"])
        if att is not None and all(v is None for v in att.values()):
            att = None
        note = notes_map.get(s["id"])
        if note is not None and not note["comment"] and not note["teacher_comment"]:
            note = None
        result.append({
            "student": dict(s),
            "class": class_map.get(s["id"]),
            "entries": entries,
            "total_tekorten": total,
            "attendance": att,
            "notes": note,
            "audience": audience,
        })
    return jsonify({"period": dict(period), "students": result})


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
