import json
import math
import os
import secrets
import sqlite3
import subprocess
from datetime import datetime, timedelta

from flask import Flask, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import openpyxl
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

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
        g.db = sqlite3.connect(DB_PATH, timeout=10)
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
    name TEXT NOT NULL UNIQUE,
    sbu_doel INTEGER NOT NULL DEFAULT 720
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
    email TEXT DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    student_number TEXT DEFAULT '',
    class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    first_name TEXT DEFAULT '',
    prefix TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    assessment_type TEXT DEFAULT 'cijfer',
    kind TEXT DEFAULT 'vak',
    sbu REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS student_keuzedelen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    grade TEXT DEFAULT '',
    UNIQUE (student_id, subject_id)
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
CREATE TABLE IF NOT EXISTS leertraject_periods (
    leertraject_id INTEGER NOT NULL REFERENCES leertrajecten(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    UNIQUE (leertraject_id, period_id)
);
CREATE TABLE IF NOT EXISTS subject_leertrajecten (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    leertraject_id INTEGER NOT NULL REFERENCES leertrajecten(id) ON DELETE CASCADE,
    UNIQUE (subject_id, leertraject_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    meeting_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    status TEXT NOT NULL DEFAULT 'open',
    include_sbu INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS meeting_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    reason TEXT DEFAULT '',
    conclusion TEXT DEFAULT '',
    followup TEXT DEFAULT '',
    UNIQUE (meeting_id, student_id)
);
CREATE TABLE IF NOT EXISTS mail_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'direct',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    recipients TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    sent_at TEXT,
    error TEXT DEFAULT ''
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
    if "login_enabled" in cols:
        try:
            db.execute("ALTER TABLE students DROP COLUMN login_enabled")
        except sqlite3.OperationalError:
            pass
    pcols = [r[1] for r in db.execute("PRAGMA table_info(periods)").fetchall()]
    if "year" not in pcols:
        db.execute("ALTER TABLE periods ADD COLUMN year TEXT DEFAULT ''")
    ccols = [r[1] for r in db.execute("PRAGMA table_info(crebos)").fetchall()]
    if "sbu_doel" not in ccols:
        db.execute("ALTER TABLE crebos ADD COLUMN sbu_doel INTEGER "
                   "NOT NULL DEFAULT 720")
    mcols = [r[1] for r in db.execute("PRAGMA table_info(meetings)").fetchall()]
    if mcols and "include_sbu" not in mcols:
        db.execute("ALTER TABLE meetings ADD COLUMN include_sbu "
                   "INTEGER NOT NULL DEFAULT 1")
    ucols = [r[1] for r in db.execute("PRAGMA table_info(users)").fetchall()]
    if "must_change_password" not in ucols:
        db.execute("ALTER TABLE users ADD COLUMN must_change_password "
                   "INTEGER NOT NULL DEFAULT 0")
    for uid, pw_hash, flagged in db.execute(
            "SELECT id, password_hash, must_change_password FROM users").fetchall():
        if not flagged and any(check_password_hash(pw_hash, d)
                               for d in ("welkom", "rapportapp")):
            db.execute("UPDATE users SET must_change_password = 1 WHERE id = ?",
                       (uid,))
    db.commit()
    # Migratie niveau -> crebo: oude tabel en kolom hernoemen.
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()]
    if "niveaus" in tables:
        db.execute("INSERT OR IGNORE INTO crebos (id, name) "
                   "SELECT id, name FROM niveaus")
        db.execute("DROP TABLE niveaus")
    # FK's die nog naar de gedropte tabel 'niveaus' verwijzen omzetten naar
    # 'crebos'; anders faalt elke INSERT/UPDATE op die tabellen met
    # 'no such table: main.niveaus' zodra foreign_keys aan staat.
    stale = db.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
        "AND sql LIKE '%REFERENCES niveaus%'").fetchall()
    if stale:
        db.execute("PRAGMA writable_schema = ON")
        for tname, sql in stale:
            db.execute(
                "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?",
                (sql.replace("REFERENCES niveaus", "REFERENCES crebos"), tname))
        db.execute("PRAGMA writable_schema = OFF")
        db.commit()
        db.close()
        db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
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
            "INSERT INTO users (username, password_hash, role, must_change_password) "
            "VALUES (?, ?, ?, 1)",
            ("beheerder", generate_password_hash("rapportapp"), "beheerder"),
        )
    for table in ("students", "classes", "subjects", "cohorts", "leertrajecten"):
        tcols = [r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
        if "archived" not in tcols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN archived INTEGER DEFAULT 0")
    if not db.execute("SELECT COUNT(*) FROM leertraject_periods").fetchone()[0] and \
            db.execute("SELECT COUNT(*) FROM subject_leertrajecten").fetchone()[0]:
        # Oude vak-leertraject-koppelingen overzetten naar module-leertraject-koppelingen.
        for lt_id, pid in db.execute(
            """SELECT DISTINCT sl.leertraject_id, sp.period_id
               FROM subject_leertrajecten sl
               JOIN subject_periods sp ON sp.subject_id = sl.subject_id"""
        ).fetchall():
            db.execute(
                "INSERT OR IGNORE INTO leertraject_periods "
                "(leertraject_id, period_id) VALUES (?, ?)", (lt_id, pid))
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
    if "kind" not in scols:
        db.execute("ALTER TABLE subjects ADD COLUMN kind TEXT DEFAULT 'vak'")
        scols.append("kind")
    if "sbu" not in scols:
        db.execute("ALTER TABLE subjects ADD COLUMN sbu REAL DEFAULT 0")
        scols.append("sbu")
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
    # De crebo van een klas komt voortaan uit het leertraject; bestaande
    # klassen met een afwijkende crebo melden zodat ze gecontroleerd kunnen
    # worden (zichtbaar in journalctl/gunicorn-log).
    mismatches = db.execute(
        """SELECT c.name, cn.name, ln.name
           FROM classes c
           JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN crebos cn ON cn.id = c.crebo_id
           LEFT JOIN crebos ln ON ln.id = lt.crebo_id
           WHERE c.crebo_id IS NOT NULL AND c.crebo_id != lt.crebo_id"""
    ).fetchall()
    if mismatches:
        print("WAARSCHUWING: de crebo op de klas wordt niet meer gebruikt en "
              "komt voortaan van het leertraject. Deze klassen hebben een "
              "afwijkende crebo: " + "; ".join(
                  f"{r[0]} (klas: {r[1]}, leertraject: {r[2]})"
                  for r in mismatches), flush=True)
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
    resp = send_from_directory(app.static_folder, "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.after_request
def no_cache_static(resp):
    if resp.mimetype in ("text/html", "application/javascript", "text/css"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.errorhandler(Exception)
def unhandled_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return e
    app.logger.exception("Onverwerkte serverfout")
    return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


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
                    "role": row["role"], "student_id": row["student_id"],
                    "must_change_password": bool(row["must_change_password"])})


@app.route("/api/auth/password", methods=["PUT"])
def auth_password():
    user, err = auth_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    current = data.get("current_password") or ""
    new = data.get("new_password") or ""
    if not check_password_hash(user["password_hash"], current):
        return jsonify({"error": "Huidig wachtwoord is niet juist"}), 400
    if len(new) < 8:
        return jsonify({"error": "Het nieuwe wachtwoord moet minimaal 8 tekens bevatten"}), 400
    if new == current:
        return jsonify({"error": "Het nieuwe wachtwoord mag niet gelijk zijn aan het oude"}), 400
    db = get_db()
    db.execute("UPDATE users SET password_hash = ?, must_change_password = 0 "
               "WHERE id = ?", (generate_password_hash(new), user["id"]))
    db.commit()
    audit(db, user, "wachtwoord", "account", user["id"], "Eigen wachtwoord gewijzigd")
    return jsonify({"ok": True})


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
                    "role": user["role"], "student_id": user["student_id"],
                    "must_change_password": bool(user["must_change_password"])})


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
                                      first_name, last_name, email,
                                      must_change_password)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1)""",
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


@app.route("/api/users/bulk", methods=["POST"])
def users_bulk():
    user, err = auth_error("beheerder")
    if err:
        return err
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    action = data.get("action")
    if action not in ("active_on", "active_off", "reset_password"):
        return jsonify({"error": "Onbekende actie"}), 400
    db = get_db()
    updated, skipped, errors = 0, 0, []
    for uid in ids:
        row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if row is None:
            skipped += 1
            continue
        if action in ("active_on", "active_off"):
            new_active = 1 if action == "active_on" else 0
            if uid == user["id"] and not new_active:
                errors.append("Je kunt jezelf niet deactiveren")
                continue
            admin_err = last_admin_check(db, uid, new_active=new_active)
            if admin_err:
                errors.append(f"{row['username']}: {admin_err}")
                continue
            db.execute("UPDATE users SET active = ? WHERE id = ?",
                       (new_active, uid))
        else:
            default = "rapportapp" if row["role"] == "beheerder" else "welkom"
            db.execute(
                "UPDATE users SET password_hash = ?, must_change_password = 1 "
                "WHERE id = ?",
                (generate_password_hash(default), uid))
        updated += 1
    db.commit()
    label = {"active_on": "activeren", "active_off": "deactiveren",
             "reset_password": "wachtwoord-reset"}[action]
    audit(db, user, label, "gebruiker", None,
          f"{updated} account(s) gewijzigd, {skipped} overgeslagen"
          + (f"; fouten: {'; '.join(errors[:3])}" if errors else ""))
    return jsonify({"ok": True, "updated": updated, "skipped": skipped,
                   "errors": errors[:50]})


@app.route("/api/users/<int:user_id>", methods=["PUT", "DELETE"])
def user_item(user_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        if data.get("password"):
            db.execute("UPDATE users SET password_hash = ?, must_change_password = ? "
                       "WHERE id = ?",
                       (generate_password_hash(data["password"]),
                        0 if user_id == user["id"] else 1, user_id))
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
              audit_detail(db, "users", user_id, gewijzigd))
    else:
        if user_id == user["id"]:
            return jsonify({"error": "Je kunt jezelf niet verwijderen"}), 400
        err = last_admin_check(db, user_id, new_role="")
        if err:
            return jsonify({"error": err}), 400
        detail = audit_detail(db, "users", user_id)
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        audit(db, user, "verwijderen", "gebruiker", user_id, detail)
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
                 "subject_classes", "subject_leertrajecten", "student_keuzedelen",
                 "leertraject_periods", "students", "subjects",
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


MAX_LOGO_BYTES = 1024 * 1024


def get_setting(db, key, default=""):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


DEFAULT_TEKORTENDREMPEL = 3
DEFAULT_AANWEZIGHEIDSGRENS = 85.0


def signal_thresholds(db):
    """Signaaldrempels uit Instellingen: (tekortendrempel, aanwezigheidsgrens)."""
    try:
        t = int(get_setting(db, "signal_tekortendrempel",
                            DEFAULT_TEKORTENDREMPEL))
    except (TypeError, ValueError):
        t = DEFAULT_TEKORTENDREMPEL
    try:
        a = float(get_setting(db, "signal_aanwezigheidsgrens",
                              DEFAULT_AANWEZIGHEIDSGRENS))
    except (TypeError, ValueError):
        a = DEFAULT_AANWEZIGHEIDSGRENS
    return t, a


# ---------------------------------------------------------------------------
# E-mailmeldingen (vergadering + rapport gereed)
# ---------------------------------------------------------------------------

DEFAULT_SMTP_PORT = 587
MAIL_EVENTS = {
    "vergadering": "Vergadering",
    "rapport": "Rapport gereed",
}
MAIL_ROLES = ("beheerder", "mentor", "docent", "administratie")


def mail_settings(db):
    return {
        "smtp_host": get_setting(db, "smtp_host"),
        "smtp_port": get_setting(db, "smtp_port", str(DEFAULT_SMTP_PORT)),
        "smtp_user": get_setting(db, "smtp_user"),
        "smtp_pass": get_setting(db, "smtp_pass"),
        "smtp_from": get_setting(db, "smtp_from"),
        "smtp_starttls": get_setting(db, "smtp_starttls", "1") == "1",
        "roles": {e: parse_roles(get_setting(db, f"mail_roles_{e}"))
                  for e in MAIL_EVENTS},
        "modes": {e: get_setting(db, f"mail_mode_{e}", "direct") for e in MAIL_EVENTS},
    }


def parse_roles(raw):
    roles = []
    for r in (raw or "").replace(";", ",").split(","):
        r = r.strip()
        if r in MAIL_ROLES and r not in roles:
            roles.append(r)
    return roles


def parse_recipients(raw):
    return [r.strip() for r in (raw or "").replace(";", ",").split(",")
            if r.strip() and "@" in r]


def role_recipients(db, roles):
    """E-mailadressen van alle actieve gebruikers binnen de gegeven rollen."""
    roles = [r for r in roles if r in MAIL_ROLES]
    if not roles:
        return []
    marks = ",".join("?" for _ in roles)
    rows = db.execute(
        f"SELECT DISTINCT email FROM users "
        f"WHERE role IN ({marks}) AND active = 1 "
        f"AND TRIM(COALESCE(email, '')) != '' ORDER BY email", roles).fetchall()
    return [r["email"].strip() for r in rows]


def event_recipients(db, event):
    cfg = mail_settings(db)
    return role_recipients(db, cfg["roles"].get(event) or [])


def smtp_send(cfg, recipients, subject, body):
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg["smtp_from"] or cfg["smtp_user"] or "rapportapp@localhost"
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)
    try:
        port = int(cfg["smtp_port"] or DEFAULT_SMTP_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_SMTP_PORT
    with smtplib.SMTP(cfg["smtp_host"], port, timeout=15) as srv:
        if cfg["smtp_starttls"]:
            srv.starttls()
        if cfg["smtp_user"]:
            srv.login(cfg["smtp_user"], cfg["smtp_pass"])
        srv.send_message(msg)


def mail_enabled(db, event):
    """True als voor deze gebeurtenis een melding kan worden verstuurd."""
    cfg = mail_settings(db)
    return bool(cfg["smtp_host"] and event_recipients(db, event))


def queue_mail(db, event, subject, body):
    """Melding in de wachtrij; bij modus 'direct' meteen proberen te versturen."""
    if event not in MAIL_EVENTS:
        return
    cfg = mail_settings(db)
    recipients = event_recipients(db, event)
    if not recipients or not cfg["smtp_host"]:
        return
    mode = cfg["modes"][event]
    if mode not in ("direct", "samenvatting"):
        mode = "direct"
    cur = db.execute(
        "INSERT INTO mail_outbox (event, mode, subject, body, recipients) "
        "VALUES (?, ?, ?, ?, ?)",
        (event, mode, subject, body, ", ".join(recipients)))
    if mode == "direct":
        try:
            smtp_send(cfg, recipients, subject, body)
            db.execute(
                "UPDATE mail_outbox SET sent_at = datetime('now','localtime'), "
                "error = '' WHERE id = ?", (cur.lastrowid,))
        except Exception as e:
            db.execute("UPDATE mail_outbox SET error = ? WHERE id = ?",
                       (str(e)[:300], cur.lastrowid))
    db.commit()


def flush_digest(db, force=False):
    """Verstuur alle wachtende samenvattingsmeldingen in één dagelijkse mail."""
    rows = db.execute(
        "SELECT * FROM mail_outbox WHERE sent_at IS NULL "
        "AND mode = 'samenvatting' ORDER BY id").fetchall()
    if not rows:
        return 0
    if not force:
        last = get_setting(db, "mail_last_digest")
        if last:
            try:
                sent_at = datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
                if datetime.now() - sent_at < timedelta(hours=24):
                    return 0
            except ValueError:
                pass
    cfg = mail_settings(db)
    if not cfg["smtp_host"]:
        return 0
    recipients = []
    for r in rows:
        for addr in parse_recipients(r["recipients"]):
            if addr not in recipients:
                recipients.append(addr)
    if not recipients:
        return 0
    body_lines = ["Dagelijkse samenvatting van RapportApp:", ""]
    for event, label in MAIL_EVENTS.items():
        ev_rows = [r for r in rows if r["event"] == event]
        if not ev_rows:
            continue
        body_lines.append(f"== {label} ==")
        for r in ev_rows:
            body_lines.append(f"- {r['subject']} ({r['created_at']})")
        body_lines.append("")
    try:
        smtp_send(cfg, recipients, "RapportApp \u2014 dagelijkse samenvatting",
                  "\n".join(body_lines))
    except Exception as e:
        db.execute("UPDATE mail_outbox SET error = ? "
                   "WHERE sent_at IS NULL AND mode = 'samenvatting'",
                   (str(e)[:300],))
        db.commit()
        return 0
    db.execute(
        "UPDATE mail_outbox SET sent_at = datetime('now','localtime'), error = '' "
        "WHERE sent_at IS NULL AND mode = 'samenvatting'")
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('mail_last_digest', "
        "datetime('now','localtime')) ON CONFLICT(key) DO UPDATE "
        "SET value = datetime('now','localtime')")
    db.commit()
    return len(rows)


@app.after_request
def try_daily_digest(response):
    try:
        db = get_db()
        flush_digest(db)
        close_db()
    except Exception:
        pass
    return response


def report_ready_students(db, period_id, student_ids):
    """Van deze studenten is het rapport voor de module compleet: alle vakken
    die aan de module zijn gekoppeld (exclusief keuzedelen) hebben een resultaat."""
    ids = [s for s in (student_ids or []) if s]
    if not ids:
        return []
    ph = ",".join("?" for _ in ids)
    expected = {}
    for r in db.execute(
        f"""SELECT sp.subject_id FROM subject_periods sp
            JOIN subjects s ON s.id = sp.subject_id
            WHERE sp.period_id = ? AND COALESCE(s.kind, 'vak') != 'keuzedeel'""",
        (period_id,)).fetchall():
        expected[r["subject_id"]] = True
    if not expected:
        return []
    done = []
    for sid in ids:
        got = {r["subject_id"] for r in db.execute(
            "SELECT subject_id FROM grades "
            "WHERE period_id = ? AND student_id = ?",
            (period_id, sid)).fetchall()}
        if expected.keys() <= got:
            done.append(sid)
    return done


def notify_report_ready(db, period_id, student_ids):
    """'Rapport gereed'-meldingen, per student+module maar één keer (dedup)."""
    for sid in report_ready_students(db, period_id, student_ids):
        student = db.execute(
            "SELECT name, student_number FROM students WHERE id = ?",
            (sid,)).fetchone()
        period = db.execute(
            "SELECT name FROM periods WHERE id = ?", (period_id,)).fetchone()
        if not student or not period:
            continue
        subject = (f"Rapport gereed: {student['name']} "
                   f"({student['student_number'] or sid}) \u2014 module {period['name']}")
        exists = db.execute(
            "SELECT COUNT(*) FROM mail_outbox WHERE event = 'rapport' "
            "AND subject = ?", (subject,)).fetchone()[0]
        if exists:
            continue
        body = (f"Het rapport van {student['name']} "
                f"({student['student_number'] or sid}) voor module "
                f"{period['name']} is compleet: alle vakken van deze module "
                "hebben een resultaat.\n\n"
                "Open RapportApp om het rapport te bekijken of af te drukken.")
        queue_mail(db, "rapport", subject, body)


@app.route("/api/settings")
def settings_get():
    user, err = auth_error()
    db = get_db()
    if err:
        return jsonify({"school_name": get_setting(db, "school_name")})
    t, a = signal_thresholds(db)
    cfg = mail_settings(db)
    return jsonify({
        "school_name": get_setting(db, "school_name"),
        "logo": get_setting(db, "logo"),
        "signal_tekortendrempel": t,
        "signal_aanwezigheidsgrens": a,
        "smtp_host": cfg["smtp_host"],
        "smtp_port": cfg["smtp_port"],
        "smtp_user": cfg["smtp_user"],
        "smtp_from": cfg["smtp_from"],
        "smtp_starttls": cfg["smtp_starttls"],
        "smtp_pass_set": bool(cfg["smtp_pass"]),
        "mail_roles": cfg["roles"],
        "mail_modes": cfg["modes"],
    })


@app.route("/api/settings", methods=["PUT"])
def settings_put():
    user, err = auth_error("beheerder")
    if err:
        return err
    data = request.get_json(silent=True) or {}
    db = get_db()
    updates = {}
    if "signal_tekortendrempel" in data:
        try:
            t = int(data["signal_tekortendrempel"])
        except (TypeError, ValueError):
            return jsonify({"error": "Tekortendrempel moet een geheel getal zijn"}), 400
        if not (1 <= t <= 50):
            return jsonify({"error": "Tekortendrempel moet tussen 1 en 50 liggen"}), 400
        updates["signal_tekortendrempel"] = str(t)
    if "signal_aanwezigheidsgrens" in data:
        try:
            a = float(data["signal_aanwezigheidsgrens"])
        except (TypeError, ValueError):
            return jsonify({"error": "Aanwezigheidsgrens moet een getal zijn"}), 400
        if not (0 <= a <= 100):
            return jsonify({"error": "Aanwezigheidsgrens moet tussen 0 en 100 liggen"}), 400
        updates["signal_aanwezigheidsgrens"] = str(a)
    if "school_name" in data:
        name = str(data["school_name"] or "").strip()
        if len(name) > 120:
            return jsonify({"error": "Schoolnaam is te lang (max. 120 tekens)"}), 400
        updates["school_name"] = name
    if "logo" in data:
        logo = str(data["logo"] or "")
        if logo:
            if not logo.startswith("data:image/"):
                return jsonify({"error": "Logo moet een afbeelding zijn (png, jpg, gif of svg)"}), 400
            if len(logo) > MAX_LOGO_BYTES:
                return jsonify({"error": "Logo is te groot (max. 700 kB als bestand)"}), 400
        updates["logo"] = logo
    if "smtp_host" in data:
        updates["smtp_host"] = str(data["smtp_host"] or "").strip()[:200]
    if "smtp_port" in data:
        port = str(data["smtp_port"] or "").strip()
        if port:
            try:
                p = int(port)
            except (TypeError, ValueError):
                return jsonify({"error": "SMTP-poort moet een getal zijn"}), 400
            if not (1 <= p <= 65535):
                return jsonify({"error": "SMTP-poort moet tussen 1 en 65535 liggen"}), 400
        updates["smtp_port"] = port
    if "smtp_user" in data:
        updates["smtp_user"] = str(data["smtp_user"] or "").strip()[:200]
    if "smtp_pass" in data:
        updates["smtp_pass"] = str(data["smtp_pass"] or "")[:200]
    if "smtp_from" in data:
        updates["smtp_from"] = str(data["smtp_from"] or "").strip()[:200]
    if "smtp_starttls" in data:
        updates["smtp_starttls"] = "1" if data["smtp_starttls"] else "0"
    for event in MAIL_EVENTS:
        if f"mail_roles_{event}" in data:
            roles = data[f"mail_roles_{event}"]
            if not isinstance(roles, list):
                return jsonify({"error": "Ontvangerrollen moeten een lijst zijn"}), 400
            bad = [r for r in roles if r not in MAIL_ROLES]
            if bad:
                return jsonify({"error": "Onbekende rol: " + str(bad[0])}), 400
            updates[f"mail_roles_{event}"] = ",".join(roles)
        if f"mail_mode_{event}" in data:
            mode = data[f"mail_mode_{event}"]
            if mode not in ("direct", "samenvatting"):
                return jsonify({"error": "Ongeldige meldingsmodus"}), 400
            updates[f"mail_mode_{event}"] = mode
    for key, value in updates.items():
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value))
    db.commit()
    audit(db, user, "wijzigen", "instellingen", None,
          ", ".join(sorted(updates)))
    return settings_get_inner(db)


def settings_get_inner(db):
    t, a = signal_thresholds(db)
    cfg = mail_settings(db)
    return jsonify({
        "school_name": get_setting(db, "school_name"),
        "logo": get_setting(db, "logo"),
        "signal_tekortendrempel": t,
        "signal_aanwezigheidsgrens": a,
        "smtp_host": cfg["smtp_host"],
        "smtp_port": cfg["smtp_port"],
        "smtp_user": cfg["smtp_user"],
        "smtp_from": cfg["smtp_from"],
        "smtp_starttls": cfg["smtp_starttls"],
        "smtp_pass_set": bool(cfg["smtp_pass"]),
        "mail_roles": cfg["roles"],
        "mail_modes": cfg["modes"],
    })


@app.route("/api/mail/outbox")
def mail_outbox_list():
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    rows = db.execute(
        "SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 1000").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/mail/test", methods=["POST"])
def mail_test():
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    cfg = mail_settings(db)
    recipients = event_recipients(db, "vergadering")
    if not recipients:
        recipients = event_recipients(db, "rapport")
    if not cfg["smtp_host"]:
        return jsonify({"error": "Vul eerst een SMTP-server in en sla op"}), 400
    if not recipients:
        return jsonify({"error": "Vink eerst minstens één rol als ontvanger aan en sla op"}), 400
    try:
        smtp_send(cfg, recipients, "RapportApp \u2014 testmelding",
                  "Dit is een testmelding van RapportApp.\n"
                  "Als je deze mail ontvangt, werkt de e-mailinstelling.")
    except Exception as e:
        return jsonify({"error": f"Versturen mislukt: {e}"}), 400
    return jsonify({"ok": True, "recipients": recipients})


@app.route("/api/mail/digest", methods=["POST"])
def mail_digest_now():
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    sent = flush_digest(db, force=True)
    if not sent:
        return jsonify({"error": "Er zijn geen wachtende samenvattingsmeldingen "
                                  "(of versturen is mislukt; zie het overzicht)"}), 400
    return jsonify({"ok": True, "sent": sent})


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
            """INSERT INTO users (username, password_hash, role, first_name,
                                  last_name, email, must_change_password)
               VALUES (?, ?, ?, ?, ?, ?, 1)""",
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


def name_of(db, table, row_id, default="onbekend"):
    if not row_id:
        return default
    r = db.execute(f"SELECT name FROM {table} WHERE id = ?", (row_id,)).fetchone()
    return r["name"] if r else default


def entity_label(db, table, row_id):
    if not row_id:
        return ""
    expr = {
        "users": "username",
        "students": "first_name || ' ' || COALESCE(prefix || ' ', '') || last_name",
    }.get(table, "name")
    r = db.execute(
        f"SELECT {expr} AS label FROM {table} WHERE id = ?", (row_id,)
    ).fetchone()
    return r["label"] if r else ""


def audit_detail(db, table, row_id, fields=None):
    label = entity_label(db, table, row_id)
    detail = f"'{label}'" if label else ""
    if fields:
        detail = f"{detail} \u2014 Velden: {', '.join(fields)}" if detail else f"Velden: {', '.join(fields)}"
    return detail


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
        """SELECT c.id, c.name, n.name AS crebo,
                  co.name AS cohort, lt.cohort_id,
                  lt.name AS leertraject, c.leertraject_id,
                  c.mentor_id, m.username AS mentor
           FROM classes c
           LEFT JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN crebos n ON n.id = lt.crebo_id
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
        updates = {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Naam is verplicht"}), 400
            updates["name"] = name
        if "archived" in data:
            updates["archived"] = 1 if data.get("archived") else 0
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            db.execute(f"UPDATE cohorts SET {sets} WHERE id = ?",
                       (*updates.values(), cohort_id))
            db.commit()
            gewijzigd = [k for k in ("name", "archived") if k in data]
            action = "hernoemen" if "name" in updates and "archived" not in updates else (
                "archiveren" if updates.get("archived") else "herstellen")
            audit(db, user, action, "cohort", cohort_id,
                  audit_detail(db, "cohorts", cohort_id, gewijzigd))
    else:
        detail = audit_detail(db, "cohorts", cohort_id)
        db.execute("DELETE FROM cohorts WHERE id = ?", (cohort_id,))
        db.commit()
        audit(db, user, "verwijderen", "cohort", cohort_id, detail)
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


@app.route("/api/crebos/<int:crebo_id>", methods=["PUT", "DELETE"])
def crebo_item(crebo_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(silent=True) or {}
        if "sbu_doel" in data:
            try:
                doel = int(data["sbu_doel"])
            except (TypeError, ValueError):
                return jsonify({"error": "Keuzedeel-SBU moet een getal zijn"}), 400
            if doel <= 0:
                return jsonify({"error": "Keuzedeel-SBU moet groter dan 0 zijn"}), 400
            db.execute("UPDATE crebos SET sbu_doel = ? WHERE id = ?",
                       (doel, crebo_id))
            db.commit()
            audit(db, user, "wijzigen", "crebo", crebo_id,
                  audit_detail(db, "crebos", crebo_id, ["sbu_doel"]))
        return jsonify({"ok": True})
    detail = audit_detail(db, "crebos", crebo_id)
    db.execute("DELETE FROM crebos WHERE id = ?", (crebo_id,))
    db.commit()
    audit(db, user, "verwijderen", "crebo", crebo_id, detail)
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
              audit_detail(db, "leertrajecten", lt_id, gewijzigd))
        row = db.execute("SELECT * FROM leertrajecten WHERE id = ?", (lt_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Leertraject niet gevonden"}), 404
        return jsonify(leertraject_with_periods(db, row))
    detail = audit_detail(db, "leertrajecten", lt_id)
    db.execute("DELETE FROM leertrajecten WHERE id = ?", (lt_id,))
    db.commit()
    audit(db, user, "verwijderen", "leertraject", lt_id, detail)
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
        mentor_id = data.get("mentor_id") or None
        leertraject_id = data.get("leertraject_id") or None
        cur = db.execute(
            "INSERT INTO classes (name, leertraject_id, mentor_id) "
            "VALUES (?, ?, ?)",
            (name, leertraject_id, mentor_id),
        )
        db.commit()
        audit(db, user, "aanmaken", "klas", cur.lastrowid, f"Klas '{name}'")
        return jsonify(class_with_crebo(db, cur.lastrowid)), 201
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        """SELECT c.id, c.name, n.name AS crebo,
                  co.name AS cohort, lt.cohort_id, c.archived,
                  lt.name AS leertraject, c.leertraject_id,
                  c.mentor_id, m.username AS mentor
           FROM classes c
           LEFT JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN crebos n ON n.id = lt.crebo_id
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
        gewijzigd = [k for k in ("name", "leertraject_id",
                                 "mentor_id", "archived") if k in data]
        audit(db, user, "wijzigen", "klas", class_id,
              audit_detail(db, "classes", class_id, gewijzigd))
    else:
        detail = audit_detail(db, "classes", class_id)
        db.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        db.commit()
        audit(db, user, "verwijderen", "klas", class_id, detail)
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
            """INSERT INTO students (name, student_number, class_id,
                                     first_name, prefix, last_name, email)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, number, class_id, first, prefix, last, email),
        )
        db.commit()
        student = dict(db.execute(
            "SELECT * FROM students WHERE id = ?", (cur.lastrowid,)
        ).fetchone())
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
            f"""SELECT st.* FROM students st
                WHERE st.archived = ? AND st.class_id IN ({placeholders})
                ORDER BY st.name""",
            (archived, *mentor_ids),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT st.* FROM students st WHERE st.archived = ? ORDER BY st.name",
            (archived,),
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/students/bulk", methods=["POST"])
def students_bulk():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    action = data.get("action")
    if not ids or action not in ("archive", "unarchive", "delete"):
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
    for r in rows:
        if action == "delete":
            db.execute("DELETE FROM students WHERE id = ?", (r["id"],))
        elif action == "archive":
            db.execute("UPDATE students SET archived = 1 WHERE id = ?", (r["id"],))
        elif action == "unarchive":
            db.execute("UPDATE students SET archived = 0 WHERE id = ?", (r["id"],))
    db.commit()
    audit(db, user, "bulk-" + action, "student", None,
          f"{len(rows)} student(en): {action}")
    return jsonify({"ok": True, "affected": len(rows)})


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
            if not mentor_owns_student(user, existing):
                return jsonify({"error": "Als mentor kun je alleen studenten van je eigen klas wijzigen"}), 403
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
        if "archived" in data:
            db.execute("UPDATE students SET archived = ? WHERE id = ?",
                       (1 if data.get("archived") else 0, student_id))
        db.commit()
        gewijzigd = [k for k in ("name", "student_number", "class_id", "first_name",
                                 "prefix", "last_name", "email",
                                 "archived") if k in data]
        audit(db, user, "wijzigen", "student", student_id,
              audit_detail(db, "students", student_id, gewijzigd))
    else:
        detail = audit_detail(db, "students", student_id)
        db.execute("DELETE FROM students WHERE id = ?", (student_id,))
        db.commit()
        audit(db, user, "verwijderen", "student", student_id, detail)
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
    result["kind"] = result.get("kind") or "vak"
    result["sbu"] = result.get("sbu") or 0
    result["period_ids"] = [
        r["period_id"] for r in db.execute(
            "SELECT period_id FROM subject_periods WHERE subject_id = ? ORDER BY period_id",
            (subject_id,),
        ).fetchall()
    ]
    return result


# ---------------------------------------------------------------------------
# Keuzedelen (direct gekoppeld aan studenten, met SBU)
# ---------------------------------------------------------------------------

KEUZEDEEL_SBU_DOEL = 720


def sbu_doel_for_lt(db, leertraject_id):
    if not leertraject_id:
        return KEUZEDEEL_SBU_DOEL
    lt = db.execute("SELECT crebo_id FROM leertrajecten WHERE id = ?",
                    (leertraject_id,)).fetchone()
    if lt is None or lt["crebo_id"] is None:
        return KEUZEDEEL_SBU_DOEL
    row = db.execute("SELECT sbu_doel FROM crebos WHERE id = ?",
                     (lt["crebo_id"],)).fetchone()
    if row is None or not row["sbu_doel"]:
        return KEUZEDEEL_SBU_DOEL
    return row["sbu_doel"]


def sbu_doel_for_student(db, student_id):
    row = db.execute(
        """SELECT c.leertraject_id FROM students st
           JOIN classes c ON c.id = st.class_id WHERE st.id = ?""",
        (student_id,)).fetchone()
    return sbu_doel_for_lt(db, row["leertraject_id"]) if row else KEUZEDEEL_SBU_DOEL


@app.route("/api/keuzedelen")
def keuzedelen_collection():
    """Alle keuzedelen (subjects met kind='keuzedeel')."""
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    archived = 1 if request.args.get("archived") == "1" else 0
    rows = db.execute(
        "SELECT * FROM subjects WHERE kind = 'keuzedeel' AND archived = ? ORDER BY name",
        (archived,)).fetchall()
    return jsonify([subject_with_periods(db, r["id"]) for r in rows])


@app.route("/api/keuzedelen/matrix")
def keuzedelen_matrix():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    class_id = request.args.get("class_id", type=int)
    cohort_id = request.args.get("cohort_id", type=int)
    where = "st.archived = 0"
    args = []
    if user["role"] == "mentor":
        own = mentor_class_ids(user)
        if not own:
            return jsonify({"keuzedelen": [], "students": [],
                            "sbu_doel": KEUZEDEEL_SBU_DOEL})
        placeholders = ",".join("?" for _ in own)
        where += f" AND st.class_id IN ({placeholders})"
        args.extend(own)
    if class_id:
        where += " AND st.class_id = ?"
        args.append(class_id)
    elif cohort_id:
        where += (" AND st.class_id IN (SELECT c.id FROM classes c "
                  "JOIN leertrajecten lt ON lt.id = c.leertraject_id "
                  "WHERE lt.cohort_id = ?)")
        args.append(cohort_id)
    students = db.execute(
        f"""SELECT st.id, st.name, st.student_number, st.first_name,
                   st.prefix, st.last_name, c.name AS class_name,
                   c.leertraject_id
            FROM students st
            LEFT JOIN classes c ON c.id = st.class_id
            WHERE {where} ORDER BY st.name""",
        args).fetchall()
    keuzedelen = db.execute(
        """SELECT id, name, sbu, assessment_type FROM subjects
           WHERE archived = 0 AND kind = 'keuzedeel' ORDER BY name""").fetchall()
    grades = {}
    sbu_totals = {}
    for r in db.execute(
        """SELECT k.student_id, k.subject_id, k.grade, s.sbu
           FROM student_keuzedelen k
           JOIN subjects s ON s.id = k.subject_id
           WHERE s.archived = 0""").fetchall():
        grades[(r["student_id"], r["subject_id"])] = r["grade"]
        sbu_totals[r["student_id"]] = sbu_totals.get(r["student_id"], 0) + (r["sbu"] or 0)
    return jsonify({
        "keuzedelen": [dict(k) for k in keuzedelen],
        "students": [{
            "id": s["id"], "name": s["name"],
            "student_number": s["student_number"],
            "first_name": s["first_name"], "prefix": s["prefix"],
            "last_name": s["last_name"], "class_name": s["class_name"],
            "grades": {str(kid): grades.get((s["id"], kid), None)
                       for kid in [k["id"] for k in keuzedelen]
                       if (s["id"], kid) in grades},
            "sbu_total": sbu_totals.get(s["id"], 0),
        } for s in students],
        "sbu_doel": (sbu_doel_for_lt(db, students[0]["leertraject_id"])
                     if students else KEUZEDEEL_SBU_DOEL),
    })


@app.route("/api/keuzedelen/bulk", methods=["POST"])
def keuzedelen_bulk():
    user, err = auth_error("beheerder", "mentor")
    if err:
        return err
    db = get_db()
    data = request.get_json(force=True)
    subject_id = data.get("subject_id")
    student_ids = data.get("student_ids") or []
    action = data.get("action")
    if not subject_id or action not in ("link", "unlink"):
        return jsonify({"error": "subject_id en action (link/unlink) zijn verplicht"}), 400
    if not student_ids:
        return jsonify({"error": "Kies eerst minimaal \u00e9\u00e9n student"}), 400
    subject = db.execute(
        "SELECT name FROM subjects WHERE id = ? AND kind = 'keuzedeel'",
        (subject_id,)).fetchone()
    if subject is None:
        return jsonify({"error": "Keuzedeel bestaat niet"}), 404
    students = db.execute(
        f"""SELECT st.* FROM students st WHERE st.id IN
           ({','.join('?' for _ in student_ids)})""",
        student_ids).fetchall()
    if user["role"] == "mentor":
        students = [s for s in students if mentor_owns_student(user, s)]
    if not students:
        return jsonify({"error": "Geen van deze studenten mag je wijzigen"}), 403
    if action == "link":
        for s in students:
            db.execute(
                "INSERT OR IGNORE INTO student_keuzedelen (student_id, subject_id) "
                "VALUES (?, ?)", (s["id"], subject_id))
    else:
        for s in students:
            db.execute(
                "DELETE FROM student_keuzedelen WHERE student_id = ? AND subject_id = ?",
                (s["id"], subject_id))
    db.commit()
    audit(db, user, "bulk-" + action, "keuzedeel", subject_id,
          f"{subject['name']} \u2014 {len(students)} student(en) "
          f"{'gekoppeld' if action == 'link' else 'ontkoppeld'}")
    return jsonify({"ok": True, "affected": len(students)})


@app.route("/api/keuzedelen/import", methods=["POST"])
def keuzedelen_import():
    user, err = auth_error("beheerder", "docent", "mentor")
    if err:
        return err
    db = get_db()
    subject_id = request.form.get("subject_id", type=int)
    file = request.files.get("file")
    if not subject_id:
        return jsonify({"error": "Kies eerst een keuzedeel"}), 400
    if not file:
        return jsonify({"error": "Geen bestand meegestuurd"}), 400
    subject = db.execute(
        "SELECT name, assessment_type FROM subjects "
        "WHERE id = ? AND kind = 'keuzedeel'", (subject_id,)).fetchone()
    if subject is None:
        return jsonify({"error": "Keuzedeel bestaat niet"}), 404
    rows = rows_from_upload(file)
    if not rows:
        return jsonify({"error": "Geen data gevonden"}), 400
    header = [str(c).strip().lower() for c in rows[0]]
    if header and ("studentnummer" in header[0] or "resultaat" in " ".join(header)):
        rows = rows[1:]
    imported, skipped = 0, 0
    errors = []
    for i, row in enumerate(rows, start=1):
        if not row or not row[0].strip():
            continue
        if len(row) < 2:
            errors.append(f"Regel {i}: te weinig kolommen (verwacht: studentnummer;resultaat)")
            continue
        number = row[0].strip()
        value = row[1].strip()
        student = db.execute(
            "SELECT * FROM students WHERE student_number = ?", (number,)).fetchone()
        if student is None:
            errors.append(f"Regel {i}: geen student met nummer {number}")
            continue
        if user["role"] == "mentor" and not mentor_owns_student(user, student):
            errors.append(f"Regel {i}: {number} is niet van jouw klas")
            continue
        db.execute(
            "INSERT OR IGNORE INTO student_keuzedelen (student_id, subject_id) "
            "VALUES (?, ?)", (student["id"], subject_id))
        parsed = None
        if value != "":
            try:
                parsed = parse_value(value, subject["assessment_type"])
            except ValueError as e:
                errors.append(f"Regel {i} ({number}): {e}")
                continue
        db.execute(
            """UPDATE student_keuzedelen SET grade = ?
               WHERE student_id = ? AND subject_id = ?""",
            (parsed, student["id"], subject_id))
        if not value:
            skipped += 1
        else:
            imported += 1
    db.commit()
    audit(db, user, "import", "keuzedeel", subject_id,
          f"{subject['name']}: {imported} resultaat(en) ge\u00efmporteerd, "
          f"{skipped} leeg, {len(errors)} fout(en)")
    return jsonify({"imported": imported, "skipped": skipped,
                    "errors": errors[:50]})


@app.route("/api/keuzedelen/grade", methods=["POST"])
def keuzedeel_grade():
    user, err = auth_error("beheerder", "docent", "mentor")
    if err:
        return err
    db = get_db()
    data = request.get_json(force=True)
    student_id = data.get("student_id")
    subject_id = data.get("subject_id")
    value = data.get("value")
    if not (student_id and subject_id):
        return jsonify({"error": "student_id en subject_id zijn verplicht"}), 400
    student = db.execute(
        "SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if student is None:
        return jsonify({"error": "Student bestaat niet"}), 404
    if user["role"] == "mentor" and not mentor_owns_student(user, student):
        return jsonify({"error": "Als mentor kun je alleen studenten van je eigen klas wijzigen"}), 403
    row = db.execute(
        """SELECT k.id, s.assessment_type, s.name FROM student_keuzedelen k
           JOIN subjects s ON s.id = k.subject_id
           WHERE k.student_id = ? AND k.subject_id = ?""",
        (student_id, subject_id)).fetchone()
    if row is None:
        return jsonify({"error": "Dit keuzedeel is niet aan deze student gekoppeld"}), 400
    parsed = None
    if value not in (None, ""):
        try:
            parsed = parse_value(value, row["assessment_type"])
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
    db.execute("UPDATE student_keuzedelen SET grade = ? WHERE id = ?",
               (parsed, row["id"]))
    db.commit()
    audit(db, user, "beoordeling", "keuzedeel", subject_id,
          f"{student['name']} \u2014 {row['name']}: {display_value(parsed) if parsed else '(leeg)'}")
    return jsonify({"ok": True, "value": display_value(parsed) if parsed else "",
                    "tekorten": tekorten_for_value(parsed) if parsed else 0})


@app.route("/api/students/<int:student_id>/keuzedelen", methods=["GET", "PUT"])
def student_keuzedelen(student_id):
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    student = db.execute(
        "SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if student is None:
        return jsonify({"error": "Student bestaat niet"}), 404
    if request.method == "PUT":
        if user["role"] == "docent" or user["role"] == "administratie":
            return jsonify({"error": "Alleen beheerders en mentoren kunnen keuzedelen koppelen"}), 403
        if user["role"] == "mentor" and not mentor_owns_student(user, student):
            return jsonify({"error": "Als mentor kun je alleen studenten van je eigen klas wijzigen"}), 403
        data = request.get_json(force=True)
        subject_ids = data.get("subject_ids")
        if subject_ids is not None:
            valid = {r["id"] for r in db.execute(
                "SELECT id FROM subjects WHERE kind = 'keuzedeel'").fetchall()}
            subject_ids = [sid for sid in subject_ids if sid in valid]
            db.execute("DELETE FROM student_keuzedelen WHERE student_id = ?",
                       (student_id,))
            for sid in subject_ids:
                db.execute(
                    "INSERT OR IGNORE INTO student_keuzedelen (student_id, subject_id) "
                    "VALUES (?, ?)", (student_id, sid))
            db.commit()
            audit(db, user, "keuzedelen", "student", student_id,
                  f"{student['name']} — keuzedelen gekoppeld: {len(subject_ids)}")
        grades_map = data.get("grades") if isinstance(data.get("grades"), dict) else None
        if grades_map:
            for sid_str, value in grades_map.items():
                try:
                    sid = int(sid_str)
                except ValueError:
                    continue
                row = db.execute(
                    """SELECT k.id, s.assessment_type FROM student_keuzedelen k
                       JOIN subjects s ON s.id = k.subject_id
                       WHERE k.student_id = ? AND k.subject_id = ?""",
                    (student_id, sid)).fetchone()
                if row is None:
                    continue
                try:
                    parsed = parse_value(value, row["assessment_type"])
                except ValueError as e:
                    return jsonify({"error": str(e)}), 400
                db.execute("UPDATE student_keuzedelen SET grade = ? WHERE id = ?",
                           (parsed, row["id"]))
            db.commit()
            audit(db, user, "keuzedeel-cijfer", "student", student_id,
                  f"{student['name']} — beoordeling keuzedeel opgeslagen")
    rows = db.execute(
        """SELECT k.subject_id, k.grade, s.name, s.sbu, s.assessment_type
           FROM student_keuzedelen k
           JOIN subjects s ON s.id = k.subject_id
           WHERE k.student_id = ?
           ORDER BY s.name""",
        (student_id,)).fetchall()
    total = sum(r["sbu"] or 0 for r in rows)
    return jsonify({
        "keuzedelen": [dict(r) for r in rows],
        "sbu_total": total,
        "sbu_doel": sbu_doel_for_student(db, student_id),
    })


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
        assessment_type = data.get("assessment_type") or "cijfer"
        if assessment_type not in ASSESSMENT_TYPES:
            return jsonify({"error": "Onbekend beoordelingstype"}), 400
        kind = data.get("kind") or "vak"
        if kind not in ("vak", "keuzedeel"):
            return jsonify({"error": "Onbekend soort vak"}), 400
        try:
            sbu = float(data.get("sbu") or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "SBU moet een getal zijn"}), 400
        cur = db.execute(
            "INSERT INTO subjects (name, assessment_type, kind, sbu) VALUES (?, ?, ?, ?)",
            (name, assessment_type, kind, sbu),
        )
        subject_id = cur.lastrowid
        for pid in period_ids:
            db.execute(
                "INSERT OR IGNORE INTO subject_periods (subject_id, period_id) VALUES (?, ?)",
                (subject_id, pid),
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

        if "assessment_type" in data:
            assessment_type = data.get("assessment_type") or "cijfer"
            if assessment_type not in ASSESSMENT_TYPES:
                return jsonify({"error": "Onbekend beoordelingstype"}), 400
            db.execute("UPDATE subjects SET assessment_type = ? WHERE id = ?",
                       (assessment_type, subject_id))
        if "kind" in data:
            kind = data.get("kind") or "vak"
            if kind not in ("vak", "keuzedeel"):
                return jsonify({"error": "Onbekend soort vak"}), 400
            db.execute("UPDATE subjects SET kind = ? WHERE id = ?", (kind, subject_id))
        if "sbu" in data:
            try:
                sbu = float(data.get("sbu") or 0)
            except (TypeError, ValueError):
                return jsonify({"error": "SBU moet een getal zijn"}), 400
            db.execute("UPDATE subjects SET sbu = ? WHERE id = ?", (sbu, subject_id))
        if "archived" in data:
            db.execute("UPDATE subjects SET archived = ? WHERE id = ?",
                       (1 if data.get("archived") else 0, subject_id))
        db.commit()
        gewijzigd = [k for k in ("name", "period_ids", "leertraject_ids",
                                 "assessment_type", "archived") if k in data]
        audit(db, user, "wijzigen", "vak", subject_id,
              audit_detail(db, "subjects", subject_id, gewijzigd))
    else:
        detail = audit_detail(db, "subjects", subject_id)
        db.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
        db.commit()
        audit(db, user, "verwijderen", "vak", subject_id, detail)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------

def period_with_leertrajecten(db, row):
    result = dict(row)
    result["leertraject_ids"] = [
        r["leertraject_id"] for r in db.execute(
            "SELECT leertraject_id FROM leertraject_periods WHERE period_id = ? "
            "ORDER BY leertraject_id", (row["id"],)).fetchall()
    ]
    return result


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
        return jsonify(period_with_leertrajecten(db, db.execute(
            "SELECT * FROM periods WHERE id = ?", (cur.lastrowid,)
        ).fetchone())), 201
    rows = db.execute("SELECT * FROM periods ORDER BY year, id").fetchall()
    return jsonify([period_with_leertrajecten(db, r) for r in rows])


@app.route("/api/periods/<int:period_id>", methods=["PUT", "DELETE"])
def period_item(period_id):
    user, err = auth_error("beheerder")
    if err:
        return err
    db = get_db()
    if request.method == "PUT":
        data = request.get_json(force=True)
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Naam is verplicht"}), 400
            year = (data.get("year") if "year" in data else None)
            if year is None:
                db.execute("UPDATE periods SET name = ? WHERE id = ?", (name, period_id))
            else:
                db.execute("UPDATE periods SET name = ?, year = ? WHERE id = ?",
                           (name, year.strip(), period_id))
        elif "year" in data:
            db.execute("UPDATE periods SET year = ? WHERE id = ?",
                       ((data.get("year") or "").strip(), period_id))
        if "leertraject_ids" in data:
            db.execute("DELETE FROM leertraject_periods WHERE period_id = ?",
                       (period_id,))
            for ltid in (data.get("leertraject_ids") or []):
                db.execute(
                    "INSERT OR IGNORE INTO leertraject_periods "
                    "(leertraject_id, period_id) VALUES (?, ?)", (ltid, period_id))
        db.commit()
        gewijzigd = [k for k in ("name", "year", "leertraject_ids") if k in data]
        audit(db, user, "wijzigen", "module", period_id,
              audit_detail(db, "periods", period_id, gewijzigd))
    else:
        detail = audit_detail(db, "periods", period_id)
        db.execute("DELETE FROM periods WHERE id = ?", (period_id,))
        db.commit()
        audit(db, user, "verwijderen", "module", period_id, detail)
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
          f"{name_of(db, 'students', student_id)} — "
          f"vak {name_of(db, 'subjects', subject_id)}, "
          f"module {name_of(db, 'periods', period_id)}: "
          f"{'verwijderd' if value == '' else value}")
    if value != "":
        try:
            notify_report_ready(db, period_id, [student_id])
        except Exception:
            pass
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
          f"{imported} cijfer(s) voor vak {subject['name']}, "
          f"module {name_of(db, 'periods', period_id)}"
          + (f"; fouten: {'; '.join(errors[:3])}" if errors else ""))
    try:
        notify_report_ready(db, period_id,
                            [e.get("student_id") for e in entries])
    except Exception:
        pass
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
    students_by_number = {r["student_number"].strip().lower(): r
                          for r in db.execute("SELECT * FROM students").fetchall()
                          if r["student_number"]}
    subjects = {r["name"].strip().lower(): r
                for r in db.execute("SELECT * FROM subjects").fetchall()}

    header = table[0]
    # Decide whether the first row is a header (contains subject names).
    first_cell = (header[0] or "").strip().lower()
    header_is_subjects = any(
        (c or "").strip().lower() in subjects for c in header[1:]
    ) or first_cell in ("", "student", "studentnummer", "nummer", "nr", "nr.", "nr.")

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
    affected = set()
    for row in data_rows:
        if not row or not (row[0] or "").strip():
            continue
        ident = row[0].strip()
        key = ident.lower()
        student = students_by_number.get(key)
        if student is None:
            skipped += 1
            errors.append(f"Onbekend studentnummer: {ident}")
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
            affected.add(student["id"])
    db.commit()
    audit(db, user, "import", "cijfers", None,
          f"{imported} cijfer(s) geïmporteerd, {skipped} overgeslagen, "
          f"{len(errors)} foutmelding(en) voor module "
          f"{name_of(db, 'periods', period_id)}")
    try:
        notify_report_ready(db, period_id, list(affected))
    except Exception:
        pass
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
        if not name:
            continue
        class_id = None
        if class_name:
            key = class_name.lower()
            if key not in classes:
                cur = db.execute(
                    "INSERT INTO classes (name) VALUES (?)", (class_name,)
                )
                db.commit()
                classes[key] = {"id": cur.lastrowid, "name": class_name}
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
    header = None
    if first in ("vak", "vakken", "subject", "subjects", "vaknaam"):
        header = rows[0]
        rows = rows[1:]
    # Beoordelingskolom herkennen (kop of tweede kolom zonder kop).
    atype_col = None
    if header:
        for i, cell in enumerate(header[1:], start=1):
            if (cell or "").strip().lower() in ("beoordeling", "beoordelingstype", "assessment", "type"):
                atype_col = i
                break
    elif len(rows[0]) > 1 and (rows[0][1] or "").strip().lower() in ASSESSMENT_TYPES:
        atype_col = 1

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
        assessment_type = "cijfer"
        if atype_col is not None and atype_col < len(row):
            candidate = (row[atype_col] or "").strip().lower()
            if candidate in ASSESSMENT_TYPES:
                assessment_type = candidate
        db.execute("INSERT INTO subjects (name, assessment_type) VALUES (?, ?)",
                   (name, assessment_type))
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
          f"{name_of(db, 'students', student_id)} — opmerkingen voor "
          f"module {name_of(db, 'periods', period_id)} "
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
          f"{name_of(db, 'students', student_id)} — aanwezigheid "
          f"module {name_of(db, 'periods', period_id)}: "
          f"{present or 0}% / {allowed or 0}% / {unallowed or 0}%")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Statistieken
# ---------------------------------------------------------------------------

def numeric_grade(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@app.route("/api/statistics")
def statistics():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    period_id = request.args.get("period_id", type=int)
    all_periods = request.args.get("period_id") == "all"
    if not period_id and not all_periods:
        return jsonify({"error": "period_id is verplicht"}), 400
    year = (request.args.get("year") or "").strip()
    class_id = request.args.get("class_id", type=int)
    cohort_id = request.args.get("cohort_id", type=int)
    db = get_db()
    drempel_tekorten, drempel_aanwezig = signal_thresholds(db)
    year_period_ids = None
    if all_periods and year:
        year_period_ids = [r["id"] for r in db.execute(
            "SELECT id FROM periods WHERE year = ?", (year,)).fetchall()]

    def period_dict():
        if all_periods:
            return {"name": "Alle modules", "year": ""}
        row = db.execute("SELECT * FROM periods WHERE id = ?", (period_id,)).fetchone()
        return dict(row) if row else {"name": "?", "year": ""}

    # Studenten in scope (zelfde regels als rapport; mentor: alleen eigen klassen).
    if user["role"] == "mentor":
        mentor_ids = mentor_class_ids(user)
        if not mentor_ids:
            return jsonify({"subjects": [], "classes": [], "signals": []})
        if class_id and class_id not in mentor_ids:
            return jsonify({"error": "Deze klas is niet van jou"}), 403
        placeholders = ",".join("?" for _ in mentor_ids)
        where = f"st.archived = 0 AND st.class_id IN ({placeholders})"
        args = list(mentor_ids)
    else:
        where = "st.archived = 0"
        args = []

    if class_id:
        where += " AND st.class_id = ?"
        args.append(class_id)
    elif cohort_id:
        where += (" AND st.class_id IN (SELECT c.id FROM classes c "
                  "JOIN leertrajecten lt ON lt.id = c.leertraject_id "
                  "WHERE lt.cohort_id = ?)")
        args.append(cohort_id)
    students = db.execute(
        f"SELECT st.*, c.name AS class_name, c.leertraject_id FROM students st "
        f"LEFT JOIN classes c ON c.id = st.class_id WHERE {where}",
        args).fetchall()
    student_filter_id = request.args.get("student_id", type=int)
    if student_filter_id:
        students = [s for s in students if s["id"] == student_filter_id]
    student_ids = [s["id"] for s in students]

    # Vakken van deze module (bij 'alle modules': alle vakken,
    # eventueel beperkt tot de modules van het gekozen leerjaar).
    if all_periods:
        if year_period_ids is None:
            subjects = db.execute(
                "SELECT * FROM subjects WHERE archived = 0 AND kind = 'vak' ORDER BY name"
            ).fetchall()
        elif year_period_ids:
            ph_p = ",".join("?" for _ in year_period_ids)
            subjects = [s for s in db.execute(
                "SELECT * FROM subjects WHERE archived = 0 AND kind = 'vak' ORDER BY name"
            ).fetchall()
                if any(r["period_id"] in year_period_ids for r in db.execute(
                    f"SELECT period_id FROM subject_periods WHERE subject_id = ?",
                    (s["id"],)).fetchall())]
        else:
            subjects = []
    else:
        subjects = [s for s in db.execute(
            "SELECT * FROM subjects WHERE archived = 0 AND kind = 'vak' ORDER BY name"
        ).fetchall()
            if period_id in {r["period_id"] for r in db.execute(
                "SELECT period_id FROM subject_periods WHERE subject_id = ?",
                (s["id"],)).fetchall()}]
    subject_ids = {s["id"] for s in subjects}

    # Cijfers, aanwezigheid en SBU ophalen. Bij 'alle modules' wordt per
    # (student, vak) de meest recente beoordeling gehanteerd.
    grades = {}
    if student_ids:
        ph = ",".join("?" for _ in student_ids)
        if all_periods:
            year_filter = ""
            year_args = []
            if year_period_ids is not None:
                if not year_period_ids:
                    year_args = None
                else:
                    year_filter = f" AND period_id IN ({','.join('?' for _ in year_period_ids)})"
                    year_args = year_period_ids
            if year_args is not None:
                for r in db.execute(
                    f"SELECT student_id, subject_id, value FROM grades "
                    f"WHERE student_id IN ({ph}){year_filter} ORDER BY period_id",
                    [*student_ids, *year_args]).fetchall():
                    grades[(r["student_id"], r["subject_id"])] = r["value"]
        else:
            for r in db.execute(
                f"SELECT student_id, subject_id, value FROM grades "
                f"WHERE period_id = ? AND student_id IN ({ph})",
                [period_id, *student_ids]).fetchall():
                grades[(r["student_id"], r["subject_id"])] = r["value"]
    attendance = {}
    if student_ids:
        ph = ",".join("?" for _ in student_ids)
        if all_periods:
            year_filter = ""
            year_args = []
            if year_period_ids is not None:
                if not year_period_ids:
                    year_args = None
                else:
                    year_filter = f" AND period_id IN ({','.join('?' for _ in year_period_ids)})"
                    year_args = year_period_ids
            if year_args is not None:
                for r in db.execute(
                    f"""SELECT student_id, AVG(present) AS present,
                              AVG(absent_allowed) AS absent_allowed,
                              AVG(absent_unallowed) AS absent_unallowed
                       FROM attendance WHERE student_id IN ({ph}){year_filter}
                       GROUP BY student_id""",
                    [*student_ids, *year_args]).fetchall():
                    attendance[r["student_id"]] = r
        else:
            for r in db.execute(
                f"SELECT student_id, present, absent_allowed, absent_unallowed "
                f"FROM attendance WHERE period_id = ? AND student_id IN ({ph})",
                [period_id, *student_ids]).fetchall():
                attendance[r["student_id"]] = r
    sbu = {}
    if student_ids:
        ph = ",".join("?" for _ in student_ids)
        for r in db.execute(
            f"SELECT k.student_id, SUM(s.sbu) AS totaal FROM student_keuzedelen k "
            f"JOIN subjects s ON s.id = k.subject_id "
            f"WHERE k.student_id IN ({ph}) GROUP BY k.student_id",
            student_ids).fetchall():
            sbu[r["student_id"]] = r["totaal"] or 0

    def is_vol(value):
        return value not in (None, "") and tekorten_for_value(value) == 0

    # Module(s) waarin elk vak voorkomt (binnen de huidige selectie).
    if all_periods:
        if year_period_ids is not None:
            scope_pids = set(year_period_ids)
        else:
            scope_pids = {r["id"] for r in db.execute(
                "SELECT id FROM periods").fetchall()}
    else:
        scope_pids = {period_id}
    period_names = {r["id"]: r["name"] for r in db.execute(
        "SELECT id, name FROM periods").fetchall()}
    subj_modules = {}
    for r in db.execute(
        "SELECT subject_id, period_id FROM subject_periods").fetchall():
        if r["period_id"] in scope_pids:
            subj_modules.setdefault(r["subject_id"], set()).add(
                period_names.get(r["period_id"], "?"))

    # Per vak.
    subject_stats = []
    for su in subjects:
        values = [v for (sid, suid), v in grades.items()
                  if suid == su["id"] and sid in student_ids]
        nums = [numeric_grade(v) for v in values]
        nums = [n for n in nums if n is not None]
        tekorten = sum(tekorten_for_value(v) for v in values)
        subject_stats.append({
            "id": su["id"],
            "name": su["name"],
            "modules": ", ".join(sorted(subj_modules.get(su["id"], set()))),
            "count": len(values),
            "avg": round(sum(nums) / len(nums), 1) if nums else None,
            "vol": sum(1 for v in values if is_vol(v)),
            "onv": sum(1 for v in values if v not in (None, "") and not is_vol(v)),
            "vs": sum(1 for v in values if v == "VS"),
            "tekorten": tekorten,
        })

    # Per klas (voor vergelijkingen).
    by_class = {}
    for s in students:
        key = s["class_name"] or "Zonder klas"
        by_class.setdefault(key, []).append(s)
    class_stats = []
    for cname, group in sorted(by_class.items()):
        gids = [g["id"] for g in group]
        values = [v for (sid, suid), v in grades.items() if sid in gids]
        nums = [numeric_grade(v) for v in values]
        nums = [n for n in nums if n is not None]
        tekorten = sum(tekorten_for_value(v) for v in values)
        atts = [attendance[g]["present"] for g in gids
                if g in attendance and attendance[g]["present"] is not None]
        class_id = group[0]["class_id"]
        class_stats.append({
            "class": cname,
            "class_id": class_id,
            "students": len(group),
            "avg": round(sum(nums) / len(nums), 1) if nums else None,
            "tekorten": tekorten,
            "tekort_per_student": round(tekorten / len(group), 2) if group else 0,
            "vol_pct": round(100 * sum(1 for v in values if is_vol(v)) / len(values), 1) if values else None,
            "attendance_avg": round(sum(atts) / len(atts), 1) if atts else None,
            "attendance_low": sum(1 for g in gids if g in attendance
                                  and attendance[g]["present"] is not None
                                  and attendance[g]["present"] < drempel_aanwezig),
        })

    # Signalering: tekortendrempel en aanwezigheidsgrens uit Instellingen.
    signals = []
    for s in students:
        st_tekorten = sum(tekorten_for_value(v)
                          for (sid, suid), v in grades.items()
                          if sid == s["id"] and suid in subject_ids)
        att = attendance.get(s["id"])
        present = round(att["present"], 1) if att and att["present"] is not None else None
        sbu_total = sbu.get(s["id"], 0)
        doel = sbu_doel_for_student(db, s["id"])
        reasons = []
        if st_tekorten >= drempel_tekorten:
            reasons.append(f"{st_tekorten} tekorten")
        if present is not None and present < drempel_aanwezig:
            reasons.append(f"aanwezigheid {present}%")
        if sbu_total < doel:
            reasons.append(f"SBU {int(sbu_total)}/{doel}")
        if reasons:
            signals.append({
                "student": s["name"],
                "student_number": s["student_number"],
                "class": s["class_name"] or "",
                "reasons": reasons,
                "tekorten": st_tekorten,
                "present": present,
                "sbu": int(sbu_total),
                "sbu_doel": doel,
            })

    # Specifieke rapporten op verzoek.
    report = request.args.get("report", "")
    if report == "keuzedelen_koppelingen":
        rows = []
        for k in db.execute(
            """SELECT id, name, sbu, assessment_type FROM subjects
               WHERE archived = 0 AND kind = 'keuzedeel' ORDER BY name""").fetchall():
            links = [dict(r) for r in db.execute(
                """SELECT student_id, grade FROM student_keuzedelen
                   WHERE subject_id = ?""", (k["id"],)).fetchall()]
            links = [l for l in links if l["student_id"] in student_ids] if student_ids else []
            values = [l["grade"] for l in links if l["grade"] not in (None, "")]
            rows.append({
                "id": k["id"], "name": k["name"], "sbu": k["sbu"] or 0,
                "count": len(links),
                "graded": len(values),
                "vol": sum(1 for v in values if is_vol(v)),
                "onv": sum(1 for v in values if not is_vol(v)),
                "vs": sum(1 for v in values if v == "VS"),
                "tekorten": sum(tekorten_for_value(v) for v in values),
            })
        return jsonify({"period": period_dict(), "report_rows": rows})
    if report == "keuzedeel_studenten":
        subject_id = request.args.get("subject_id", type=int)
        kd_row = db.execute(
            "SELECT name, sbu FROM subjects WHERE id = ? AND kind = 'keuzedeel'",
            (subject_id,)).fetchone()
        if kd_row is None:
            return jsonify({"error": "Keuzedeel bestaat niet"}), 404
        rows = []
        for r in db.execute(
            """SELECT k.student_id, k.grade, st.name, st.student_number,
                      st.class_id FROM student_keuzedelen k
               JOIN students st ON st.id = k.student_id
               WHERE k.subject_id = ? ORDER BY st.name""",
            (subject_id,)).fetchall():
            if r["student_id"] not in student_ids:
                continue
            cls = next((s["class_name"] for s in students
                        if s["id"] == r["student_id"]), "")
            rows.append({
                "student": r["name"], "student_number": r["student_number"],
                "class": cls,
                "value": display_value(r["grade"]) if r["grade"] else "",
                "tekorten": tekorten_for_value(r["grade"]) if r["grade"] else 0,
            })
        return jsonify({"period": period_dict(),
                        "subject_name": kd_row["name"],
                        "sbu": kd_row["sbu"] or 0,
                        "report_rows": rows})
    if report == "signalering":
        return jsonify({"period": period_dict(),
                        "report_rows": signals,
                        "thresholds": {"tekortendrempel": drempel_tekorten,
                                       "aanwezigheidsgrens": drempel_aanwezig}})
    if report == "resultaten":
        period_lts_map = {}
        for r in db.execute(
            "SELECT period_id, leertraject_id FROM leertraject_periods"
        ).fetchall():
            period_lts_map.setdefault(r["period_id"], set()).add(r["leertraject_id"])
        subj_names = {r["id"]: r["name"] for r in db.execute(
            "SELECT id, name FROM subjects").fetchall()}
        period_info = {r["id"]: dict(r) for r in db.execute(
            "SELECT id, name, year FROM periods").fetchall()}
        rows = []
        for s in students:
            st_grades = db.execute(
                """SELECT period_id, subject_id, value FROM grades
                   WHERE student_id = ? ORDER BY period_id, subject_id""",
                (s["id"],)).fetchall()
            if not st_grades:
                continue
            st_att = {r["period_id"]: r["present"] for r in db.execute(
                """SELECT period_id, present FROM attendance
                   WHERE student_id = ?""", (s["id"],)).fetchall()}
            by_period = {}
            for g in st_grades:
                by_period.setdefault(g["period_id"], []).append(g)
            modules = []
            for pid, gl in sorted(by_period.items()):
                entries = [{
                    "subject": subj_names.get(g["subject_id"], "?"),
                    "value": display_value(g["value"]),
                    "tekorten": tekorten_for_value(g["value"]),
                } for g in gl]
                info = period_info.get(pid, {})
                modules.append({
                    "period_id": pid,
                    "period_name": info.get("name", "?"),
                    "period_year": info.get("year", ""),
                    "in_traject": (s["leertraject_id"] is None
                                   or s["leertraject_id"] in period_lts_map.get(pid, set())),
                    "present": st_att.get(pid),
                    "tekorten": sum(e["tekorten"] for e in entries),
                    "entries": entries,
                })
            rows.append({
                "student": s["name"], "student_number": s["student_number"],
                "class": s["class_name"] or "", "modules": modules,
            })
        return jsonify({"report_rows": rows})
    if report == "keuzedelen":
        rows = []
        for s in students:
            total = sbu.get(s["id"], 0)
            doel = sbu_doel_for_student(db, s["id"])
            if total >= doel:
                continue
            names = [r["name"] for r in db.execute(
                """SELECT s2.name FROM student_keuzedelen k
                   JOIN subjects s2 ON s2.id = k.subject_id
                   WHERE k.student_id = ? ORDER BY s2.name""",
                (s["id"],)).fetchall()]
            rows.append({
                "student": s["name"], "student_number": s["student_number"],
                "class": s["class_name"] or "", "sbu": int(total),
                "sbu_doel": doel,
                "tekort": int(doel - total),
                "keuzedelen": ", ".join(names) or "(geen gekoppeld)",
            })
        return jsonify({"period": period_dict(),
            "report_rows": rows})
    if report == "aanwezigheid":
        rows = []
        for s in students:
            att = attendance.get(s["id"])
            if att is None or att["present"] is None or att["present"] >= drempel_aanwezig:
                continue
            rows.append({
                "student": s["name"], "student_number": s["student_number"],
                "class": s["class_name"] or "",
                "present": round(att["present"], 1) if att["present"] is not None else None,
                "absent_allowed": round(att["absent_allowed"], 1) if att["absent_allowed"] is not None else None,
                "absent_unallowed": round(att["absent_unallowed"], 1) if att["absent_unallowed"] is not None else None,
            })
        return jsonify({"period": period_dict(),
            "report_rows": rows})
    if report == "detail":
        subject_id = request.args.get("subject_id", type=int)
        flt = request.args.get("filter", "")
        subject_row = db.execute(
            "SELECT name FROM subjects WHERE id = ?", (subject_id,)).fetchone()
        rows = []
        for s in students:
            v = grades.get((s["id"], subject_id))
            if v in (None, ""):
                continue
            t = tekorten_for_value(v)
            if flt == "onvoldoendes" and t <= 0:
                continue
            if flt == "voldoendes" and t > 0:
                continue
            if flt == "vs" and str(v).upper() != "VS":
                continue
            rows.append({
                "student": s["name"], "student_number": s["student_number"],
                "class": s["class_name"] or "",
                "value": display_value(v), "tekorten": t,
            })
        return jsonify({"period": period_dict(),
            "subject_name": subject_row["name"] if subject_row else "?",
            "filter": flt,
            "report_rows": rows})
    if report == "onvoldoendes":
        rows = []
        for s in students:
            fails = []
            for (sid, suid), v in grades.items():
                if sid != s["id"] or suid not in subject_ids:
                    continue
                t = tekorten_for_value(v)
                if t > 0:
                    su_name = next((x["name"] for x in subjects if x["id"] == suid), "?")
                    fails.append({"subject": su_name, "value": display_value(v),
                                  "tekorten": t})
            if fails:
                rows.append({
                    "student": s["name"], "student_number": s["student_number"],
                    "class": s["class_name"] or "",
                    "total_tekorten": sum(f["tekorten"] for f in fails),
                    "fails": fails,
                })
        return jsonify({"period": period_dict(),
            "report_rows": rows})

    return jsonify({
        "period": period_dict(),
        "subjects": subject_stats,
        "classes": class_stats,
        "signals": signals,
        "thresholds": {"tekortendrempel": drempel_tekorten,
                       "aanwezigheidsgrens": drempel_aanwezig},
    })


@app.route("/api/statistics/export", methods=["POST"])
def statistics_export():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    sheets = payload.get("sheets") or []
    if not isinstance(sheets, list) or not sheets:
        return jsonify({"error": "Geen gegevens om te exporteren"}), 400
    if len(sheets) > 20:
        sheets = sheets[:20]

    def safe_sheet_name(name, used):
        base = "".join(ch for ch in str(name or "Blad") if ch not in "[]:*?/\\"
                       ).strip()[:31] or "Blad"
        candidate, n = base, 2
        while candidate.lower() in used:
            suffix = f" ({n})"
            candidate = base[:31 - len(suffix)] + suffix
            n += 1
        used.add(candidate.lower())
        return candidate

    def cell_value(v):
        if v is None:
            return None
        if isinstance(v, (int, float, bool)):
            return v
        if isinstance(v, (list, dict)):
            return json.dumps(v, ensure_ascii=False)
        return str(v)

    import io
    wb = openpyxl.Workbook()
    default_ws = wb.active
    used = set()
    for sh in sheets:
        ws = wb.create_sheet(title=safe_sheet_name(sh.get("name"), used))
        headers = sh.get("headers") or []
        if headers:
            ws.append([cell_value(h) for h in headers])
            for cell in ws[1]:
                cell.font = Font(bold=True)
        for row in sh.get("rows") or []:
            ws.append([cell_value(c) for c in row])
        widths = sh.get("widths") or []
        for i, w in enumerate(widths, start=1):
            if isinstance(w, (int, float)) and w > 0:
                ws.column_dimensions[get_column_letter(i)].width = w
    wb.remove(default_ws)
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    filename = (payload.get("filename") or "statistieken").strip()
    filename = "".join(ch for ch in filename if ch not in "/\\:*?\"<>|") or "statistieken"
    return send_file(
        out,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"{filename}.xlsx",
    )


# ---------------------------------------------------------------------------
# Rapportvergaderingen (bespreeklijst per klas + module)
# ---------------------------------------------------------------------------

def meeting_student_signals(db, class_id, period_id, include_sbu=True):
    """Per student van een klas de signaleringscijfers voor een module:
    tekorten, aanwezigheid en SBU-voortgang (zelfde regels als de signalering)."""
    students = db.execute(
        "SELECT id FROM students WHERE class_id = ? AND archived = 0",
        (class_id,)).fetchall()
    ids = [s["id"] for s in students]
    if not ids:
        return {}
    ph = ",".join("?" for _ in ids)
    tekorten = {}
    for r in db.execute(
        f"SELECT student_id, SUM({_tekorten_sql()}) AS t FROM grades "
        f"WHERE period_id = ? AND student_id IN ({ph}) GROUP BY student_id",
        [period_id, *ids]).fetchall():
        tekorten[r["student_id"]] = r["t"] or 0
    att = {}
    for r in db.execute(
        f"SELECT student_id, present, absent_allowed, absent_unallowed "
        f"FROM attendance WHERE period_id = ? AND student_id IN ({ph})",
        [period_id, *ids]).fetchall():
        att[r["student_id"]] = r
    sbu = {}
    for r in db.execute(
        f"""SELECT k.student_id, SUM(s.sbu) AS t FROM student_keuzedelen k
            JOIN subjects s ON s.id = k.subject_id
            WHERE k.student_id IN ({ph}) GROUP BY k.student_id""",
        ids).fetchall():
        sbu[r["student_id"]] = r["t"] or 0
    drempel_tekorten, drempel_aanwezig = signal_thresholds(db)
    result = {}
    for sid in ids:
        doel = sbu_doel_for_student(db, sid)
        att_row = att.get(sid)
        present = att_row["present"] if att_row else None
        t = tekorten.get(sid, 0)
        reasons = []
        if t >= drempel_tekorten:
            reasons.append(f"{t} tekorten")
        if present is not None and present < drempel_aanwezig:
            reasons.append(f"aanwezigheid {round(present, 1)}%")
        if include_sbu and sbu.get(sid, 0) < doel:
            reasons.append(f"SBU {int(sbu.get(sid, 0))}/{doel}")
        result[sid] = {
            "tekorten": t,
            "present": round(present, 1) if present is not None else None,
            "absent_allowed": round(att_row["absent_allowed"], 1)
            if att_row and att_row["absent_allowed"] is not None else None,
            "absent_unallowed": round(att_row["absent_unallowed"], 1)
            if att_row and att_row["absent_unallowed"] is not None else None,
            "sbu": int(sbu.get(sid, 0)),
            "sbu_doel": doel,
            "reasons": reasons,
        }
    return result


def _tekorten_sql():
    """SQL-expressie voor het aantal tekorten van een beoordelingswaarde.
    Spiegel van tekorten_for_value() voor gebruik in SUM()."""
    return ("CASE value WHEN 'VS' THEN 0 WHEN 'V' THEN 0 WHEN 'G' THEN 0 "
            "WHEN 'NV' THEN 1 WHEN 'O' THEN 1 "
            "WHEN value NOT GLOB '*[0-9]*' THEN 0 "
            "ELSE MAX(0, 6 - MAX(1, CAST(ROUND(CAST(value AS REAL), 0) AS INTEGER))) "
            "END")


def meeting_row(db, meeting_id):
    return db.execute(
        """SELECT m.*, c.name AS class_name, p.name AS period_name,
                  p.year AS period_year
           FROM meetings m
           JOIN classes c ON c.id = m.class_id
           JOIN periods p ON p.id = m.period_id
           WHERE m.id = ?""",
        (meeting_id,)).fetchone()


def meeting_access(user, meeting):
    """True als deze gebruiker de vergadering mag gebruiken (niet alleen lezen)."""
    if user["role"] in ("beheerder", "docent"):
        return True
    if user["role"] == "mentor":
        ids = mentor_class_ids(user)
        return meeting["class_id"] in ids if ids else False
    return False


@app.route("/api/meetings")
def meetings_collection():
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    where, args = "1=1", []
    if user["role"] == "mentor":
        ids = mentor_class_ids(user)
        if not ids:
            return jsonify([])
        where = f"m.class_id IN ({','.join('?' for _ in ids)})"
        args = list(ids)
    class_id = request.args.get("class_id", type=int)
    if class_id:
        where += " AND m.class_id = ?"
        args.append(class_id)
    period_id = request.args.get("period_id", type=int)
    if period_id:
        where += " AND m.period_id = ?"
        args.append(period_id)
    rows = db.execute(
        f"""SELECT m.id, m.class_id, m.period_id, m.meeting_date, m.status,
                  m.created_at, c.name AS class_name, p.name AS period_name,
                  p.year AS period_year,
                  (SELECT COUNT(*) FROM meeting_items i
                    WHERE i.meeting_id = m.id) AS items,
                  (SELECT COUNT(*) FROM meeting_items i
                    WHERE i.meeting_id = m.id AND i.followup != '') AS followups
           FROM meetings m
           JOIN classes c ON c.id = m.class_id
           JOIN periods p ON p.id = m.period_id
           WHERE {where}
           ORDER BY m.meeting_date DESC, m.id DESC""",
        args).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/meetings", methods=["POST"])
def meetings_create():
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    data = request.get_json(silent=True) or {}
    class_id = data.get("class_id")
    period_id = data.get("period_id")
    if not class_id or not period_id:
        return jsonify({"error": "class_id en period_id zijn verplicht"}), 400
    db = get_db()
    cls = db.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone()
    if cls is None:
        return jsonify({"error": "Klas bestaat niet"}), 404
    period = db.execute("SELECT * FROM periods WHERE id = ?", (period_id,)).fetchone()
    if period is None:
        return jsonify({"error": "Module bestaat niet"}), 404
    mentor_ids = mentor_class_ids(user)
    if user["role"] == "mentor" and (not mentor_ids or class_id not in mentor_ids):
        return jsonify({"error": "Deze klas is niet van jou"}), 403
    meeting_date = (data.get("meeting_date") or "").strip()
    include_sbu = 1 if data.get("include_sbu", False) else 0
    if meeting_date:
        db.execute(
            "INSERT INTO meetings (class_id, period_id, meeting_date, include_sbu, created_by) "
            "VALUES (?, ?, ?, ?, ?)",
            (class_id, period_id, meeting_date, include_sbu, user["id"]))
    else:
        db.execute(
            "INSERT INTO meetings (class_id, period_id, include_sbu, created_by) "
            "VALUES (?, ?, ?, ?)",
            (class_id, period_id, include_sbu, user["id"]))
    db.commit()
    meeting_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    signals = meeting_student_signals(db, class_id, period_id,
                                       include_sbu=bool(include_sbu))
    added = 0
    for sid, sig in signals.items():
        if sig["reasons"]:
            db.execute(
                "INSERT OR IGNORE INTO meeting_items (meeting_id, student_id, reason) "
                "VALUES (?, ?, ?)",
                (meeting_id, sid, ", ".join(sig["reasons"])))
            added += 1
    db.commit()
    audit(db, user, "aanmaak", "vergadering", meeting_id,
          f"{cls['name']} / {period['name']} \u2014 {added} student(en) auto-geselecteerd")
    try:
        if mail_enabled(db, "vergadering"):
            lines = [f"Er is een rapportvergadering aangemaakt: "
                     f"{cls['name']} \u2014 module {period['name']}.",
                     f"Datum: {meeting_date or 'vandaag'}", "",
                     f"Bespreeklijst ({added} student(en), volgens de "
                     "signaalcriteria):"]
            for it in db.execute(
                """SELECT st.first_name, st.prefix, st.last_name,
                          st.student_number, i.reason
                   FROM meeting_items i JOIN students st ON st.id = i.student_id
                   WHERE i.meeting_id = ? ORDER BY st.last_name, st.first_name""",
                (meeting_id,)).fetchall():
                name = " ".join(x for x in [it["first_name"], it["prefix"],
                                          it["last_name"]] if x)
                lines.append(f"- {name} ({it['student_number'] or it['student_id']})"
                             + (f": {it['reason']}" if it["reason"] else ""))
            if not added:
                lines.append("(geen studenten op de bespreeklijst)")
            queue_mail(db, "vergadering",
                       f"Vergadering aangemaakt: {cls['name']} / {period['name']}",
                       "\n".join(lines))
    except Exception:
        pass
    return jsonify({"id": meeting_id, "auto_added": added}), 201


@app.route("/api/meetings/<int:meeting_id>")
def meetings_detail(meeting_id):
    user, err = auth_error("beheerder", "mentor", "docent", "administratie")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if user["role"] == "mentor":
        ids = mentor_class_ids(user)
        if not ids or meeting["class_id"] not in ids:
            return jsonify({"error": "Deze klas is niet van jou"}), 403
    signals = meeting_student_signals(
        db, meeting["class_id"], meeting["period_id"],
        include_sbu=bool(meeting["include_sbu"]))
    items = db.execute(
        """SELECT i.student_id, i.reason, i.conclusion, i.followup,
                  st.first_name, st.prefix, st.last_name, st.student_number
           FROM meeting_items i
           JOIN students st ON st.id = i.student_id
           WHERE i.meeting_id = ? ORDER BY st.last_name, st.first_name""",
        (meeting_id,)).fetchall()
    subj_names = {r["id"]: r["name"] for r in db.execute(
        "SELECT id, name FROM subjects").fetchall()}
    notes = {r["student_id"]: r for r in db.execute(
        "SELECT student_id, comment, teacher_comment FROM notes WHERE period_id = ?",
        (meeting["period_id"],)).fetchall()}
    prev = {}
    for r in db.execute(
        """SELECT i.student_id, i.conclusion, i.followup, m.meeting_date
           FROM meeting_items i JOIN meetings m ON m.id = i.meeting_id
           WHERE m.class_id = ? AND m.id != ? AND m.id < ?
             AND (i.conclusion != '' OR i.followup != '')
           ORDER BY m.id""",
        (meeting["class_id"], meeting_id, meeting_id)).fetchall():
        prev[r["student_id"]] = dict(r)
    result_items = []
    for it in items:
        sid = it["student_id"]
        grades = db.execute(
            """SELECT subject_id, value FROM grades
               WHERE student_id = ? AND period_id = ? ORDER BY subject_id""",
            (sid, meeting["period_id"])).fetchall()
        keuzedelen = db.execute(
            """SELECT s.name, s.sbu, k.grade FROM student_keuzedelen k
               JOIN subjects s ON s.id = k.subject_id
               WHERE k.student_id = ? ORDER BY s.name""",
            (sid,)).fetchall()
        note = notes.get(sid)
        sig = signals.get(sid, {"tekorten": 0, "present": None,
                                "sbu": 0, "sbu_doel": 720, "reasons": []})
        result_items.append({
            "student_id": sid,
            "student": " ".join(x for x in [it["first_name"], it["prefix"],
                                     it["last_name"]] if x),
            "student_number": it["student_number"],
            "reason": it["reason"],
            "conclusion": it["conclusion"],
            "followup": it["followup"],
            "tekorten": sig["tekorten"],
            "present": sig["present"],
            "absent_allowed": sig["absent_allowed"],
            "absent_unallowed": sig["absent_unallowed"],
            "sbu": sig["sbu"],
            "sbu_doel": sig["sbu_doel"],
            "signals": sig["reasons"],
            "grades": [{"subject": subj_names.get(g["subject_id"], "?"),
                        "value": display_value(g["value"]),
                        "tekorten": tekorten_for_value(g["value"])}
                       for g in grades],
            "keuzedelen": [{"name": k["name"], "sbu": k["sbu"] or 0,
                            "value": display_value(k["grade"]) if k["grade"] else ""}
                           for k in keuzedelen],
            "note": note["comment"] if note else "",
            "teacher_note": note["teacher_comment"] if note else "",
            "previous": prev.get(sid),
        })
    meeting_dict = dict(meeting)
    meeting_dict.pop("created_by", None)
    t, a = signal_thresholds(db)
    return jsonify({"meeting": meeting_dict, "items": result_items,
                    "signals": signals,
                    "thresholds": {"tekortendrempel": t,
                                   "aanwezigheidsgrens": a}})


@app.route("/api/meetings/<int:meeting_id>", methods=["PUT"])
def meetings_update(meeting_id):
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if not meeting_access(user, meeting):
        return jsonify({"error": "Deze vergadering is niet van jou"}), 403
    data = request.get_json(silent=True) or {}
    fields, args = [], []
    if "status" in data:
        if data["status"] not in ("open", "afgerond"):
            return jsonify({"error": "Ongeldige status"}), 400
        fields.append("status = ?")
        args.append(data["status"])
    if "meeting_date" in data:
        fields.append("meeting_date = ?")
        args.append((data["meeting_date"] or "").strip() or None)
    if not fields:
        return jsonify({"error": "Niets te wijzigen"}), 400
    args.append(meeting_id)
    db.execute(f"UPDATE meetings SET {', '.join(fields)} WHERE id = ?", args)
    db.commit()
    audit(db, user, "wijziging", "vergadering", meeting_id,
          f"{meeting['class_name']} / {meeting['period_name']} \u2014 "
          f"Velden: {', '.join(f.split(' = ')[0] for f in fields)}")
    if data.get("status") == "afgerond":
        try:
            if mail_enabled(db, "vergadering"):
                lines = [f"De rapportvergadering van {meeting['class_name']} "
                         f"\u2014 module {meeting['period_name']} is afgerond.", "",
                         "Genomen conclusies en vervolgacties:"]
                for it in db.execute(
                    """SELECT st.first_name, st.prefix, st.last_name,
                              st.student_number, i.conclusion, i.followup
                       FROM meeting_items i
                       JOIN students st ON st.id = i.student_id
                       WHERE i.meeting_id = ?
                       ORDER BY st.last_name, st.first_name""",
                    (meeting_id,)).fetchall():
                    name = " ".join(x for x in [it["first_name"], it["prefix"],
                                              it["last_name"]] if x)
                    lines.append(f"- {name} "
                                 f"({it['student_number'] or it['student_id']})")
                    if it["conclusion"]:
                        lines.append(f"  Conclusie: {it['conclusion']}")
                    if it["followup"]:
                        lines.append(f"  Vervolgactie: {it['followup']}")
                queue_mail(db, "vergadering",
                           f"Vergadering afgerond: {meeting['class_name']} / "
                           f"{meeting['period_name']}",
                           "\n".join(lines))
        except Exception:
            pass
    return jsonify({"ok": True})


@app.route("/api/meetings/<int:meeting_id>", methods=["DELETE"])
def meetings_delete(meeting_id):
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if not meeting_access(user, meeting):
        return jsonify({"error": "Deze vergadering is niet van jou"}), 403
    db.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    db.commit()
    audit(db, user, "verwijdering", "vergadering", meeting_id,
          f"{meeting['class_name']} / {meeting['period_name']}")
    return jsonify({"ok": True})


@app.route("/api/meetings/<int:meeting_id>/items", methods=["POST"])
def meeting_items_add(meeting_id):
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if not meeting_access(user, meeting):
        return jsonify({"error": "Deze vergadering is niet van jou"}), 403
    data = request.get_json(silent=True) or {}
    student_id = data.get("student_id")
    if not student_id:
        return jsonify({"error": "student_id is verplicht"}), 400
    student = db.execute(
        "SELECT * FROM students WHERE id = ? AND archived = 0",
        (student_id,)).fetchone()
    if student is None or student["class_id"] != meeting["class_id"]:
        return jsonify({"error": "Student zit niet in de klas van deze vergadering"}), 400
    reason = (data.get("reason") or "").strip()
    db.execute(
        "INSERT OR IGNORE INTO meeting_items (meeting_id, student_id, reason) "
        "VALUES (?, ?, ?)", (meeting_id, student_id, reason))
    db.commit()
    audit(db, user, "toevoeging", "vergadering", meeting_id,
          f"student {student['student_number'] or student_id} toegevoegd aan "
          f"{meeting['class_name']} / {meeting['period_name']}")
    return jsonify({"ok": True}), 201


@app.route("/api/meetings/<int:meeting_id>/items/<int:student_id>", methods=["PUT"])
def meeting_items_update(meeting_id, student_id):
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if not meeting_access(user, meeting):
        return jsonify({"error": "Deze vergadering is niet van jou"}), 403
    data = request.get_json(silent=True) or {}
    fields, args, names = [], [], []
    for key in ("reason", "conclusion", "followup"):
        if key in data:
            fields.append(f"{key} = ?")
            args.append((data[key] or "").strip())
            names.append(key)
    if not fields:
        return jsonify({"error": "Niets te wijzigen"}), 400
    args += [meeting_id, student_id]
    db.execute(
        f"UPDATE meeting_items SET {', '.join(fields)} "
        "WHERE meeting_id = ? AND student_id = ?", args)
    db.commit()
    audit(db, user, "wijziging", "vergadering", meeting_id,
          f"bespreking van student {student_id} bijgewerkt "
          f"({meeting['class_name']} / {meeting['period_name']}) \u2014 "
          f"Velden: {', '.join(names)}")
    return jsonify({"ok": True})


@app.route("/api/meetings/<int:meeting_id>/items/<int:student_id>", methods=["DELETE"])
def meeting_items_delete(meeting_id, student_id):
    user, err = auth_error("beheerder", "mentor", "docent")
    if err:
        return err
    db = get_db()
    meeting = meeting_row(db, meeting_id)
    if meeting is None:
        return jsonify({"error": "Vergadering bestaat niet"}), 404
    if not meeting_access(user, meeting):
        return jsonify({"error": "Deze vergadering is niet van jou"}), 403
    db.execute(
        "DELETE FROM meeting_items WHERE meeting_id = ? AND student_id = ?",
        (meeting_id, student_id))
    db.commit()
    audit(db, user, "verwijdering", "vergadering", meeting_id,
          f"student {student_id} verwijderd uit "
          f"{meeting['class_name']} / {meeting['period_name']}")
    return jsonify({"ok": True})


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
    # Module-leertraject-koppeling: zit de module niet in het traject van de klas,
    # dan toont het rapport voor deze student geen vakken.
    period_lts = {r["leertraject_id"] for r in db.execute(
        "SELECT leertraject_id FROM leertraject_periods WHERE period_id = ?",
        (period_id,)).fetchall()}
    # Vak-klasse-koppeling: alleen vakken waarvan de klas is aangevinkt.
    # Bepaal per student de relevante klas (of de geselecteerde klas van het rapport).
    class_lt_map = {}
    for r in db.execute(
        "SELECT id, leertraject_id FROM classes WHERE leertraject_id IS NOT NULL"
    ).fetchall():
        class_lt_map[r["id"]] = r["leertraject_id"]
    class_map = {}
    for r in db.execute(
        """SELECT st.id AS sid, c.name AS cname, n.name AS ccrebo,
                  co.name AS ccohort,
                  CASE WHEN m.id IS NOT NULL AND
                            ((m.first_name IS NOT NULL AND m.first_name != '')
                             OR (m.last_name IS NOT NULL AND m.last_name != ''))
                       THEN TRIM(COALESCE(m.first_name, '') || ' ' ||
                                 COALESCE(m.last_name, ''))
                       ELSE m.username END AS cmentor
           FROM students st
           LEFT JOIN classes c ON c.id = st.class_id
           LEFT JOIN leertrajecten lt ON lt.id = c.leertraject_id
           LEFT JOIN crebos n ON n.id = lt.crebo_id
           LEFT JOIN cohorts co ON co.id = lt.cohort_id
           LEFT JOIN users m ON m.id = c.mentor_id"""
    ).fetchall():
        class_map[r["sid"]] = (
            {"name": r["cname"], "crebo": r["ccrebo"],
             "cohort": r["ccohort"], "mentor": r["cmentor"]}
            if r["cname"] else None
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
            if student_lt is not None and period_lts and student_lt not in period_lts:
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
        kz_rows = db.execute(
            """SELECT s.name, s.sbu, k.grade
               FROM student_keuzedelen k
               JOIN subjects s ON s.id = k.subject_id
               WHERE k.student_id = ?
               ORDER BY s.name""",
            (s["id"],)).fetchall()
        keuzedelen = [{
            "name": r["name"],
            "sbu": r["sbu"] or 0,
            "value": display_value(r["grade"]) if r["grade"] else "",
            "tekorten": tekorten_for_value(r["grade"]) if r["grade"] else 0,
        } for r in kz_rows]
        result.append({
            "student": dict(s),
            "class": class_map.get(s["id"]),
            "entries": entries,
            "total_tekorten": total,
            "attendance": att,
            "notes": note,
            "keuzedelen": keuzedelen,
            "sbu_total": sum(k["sbu"] for k in keuzedelen),
            "sbu_doel": sbu_doel_for_student(db, s["id"]),
            "audience": audience,
        })
    return jsonify({"period": dict(period), "students": result})


init_db()


# ---------------------------------------------------------------------------
# Optioneel HTTPS: standaard uit (HTTP, zoals voorheen).
#   RAPPORTAPP_TLS=1                              -> self-signed cert (map tls/)
#   RAPPORTAPP_TLS_CERTFILE + ..._KEYFILE         -> eigen certificaat
# Achter een reverse proxy (Caddy/nginx) laat je deze variabelen weg.
# ---------------------------------------------------------------------------
TLS_DIR = os.path.join(APP_DIR, "tls")


def ensure_self_signed_cert():
    cert = os.path.join(TLS_DIR, "selfsigned.crt")
    key = os.path.join(TLS_DIR, "selfsigned.key")
    if not (os.path.isfile(cert) and os.path.isfile(key)):
        os.makedirs(TLS_DIR, exist_ok=True)
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", key, "-out", cert, "-days", "825",
             "-subj", "/CN=rapportapp"],
            check=True,
        )
    return cert, key


def tls_ssl_context():
    if not os.environ.get("RAPPORTAPP_TLS"):
        return None
    cert = os.environ.get("RAPPORTAPP_TLS_CERTFILE")
    key = os.environ.get("RAPPORTAPP_TLS_KEYFILE")
    if cert and key:
        if not (os.path.isfile(cert) and os.path.isfile(key)):
            raise SystemExit(f"TLS-certificaat of -key niet gevonden: {cert} / {key}")
        return cert, key
    return ensure_self_signed_cert()


if __name__ == "__main__":
    context = tls_ssl_context()
    if context:
        print("HTTPS actief (self-signed): https://<server-ip>:5000")
    app.run(host="0.0.0.0", port=5000, debug=True, ssl_context=context)
