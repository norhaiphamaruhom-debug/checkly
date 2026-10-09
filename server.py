"""
Checkly - Student Attendance System
Pure-Python backend (standard library only - no pip installs required).

Run with:
    python3 server.py

Then open:
    http://localhost:8000

Default seeded admin account:
    email:    admin@checkly.com
    password: admin123

Roles:
    admin   - manage all accounts (create/edit/delete, reset passwords, bulk
              import, view all-time trends and today's attendance)
    teacher - view students, mark attendance for today or any past date,
              mark everyone present at once, undo a mark
    student - view their own attendance history and overall percentage
"""

import hashlib
import json
import mimetypes
import os
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "checkly.db")
YEAR_LEVELS = ("1st Year", "2nd Year", "3rd Year", "4th Year")
PASSWORD_SALT = "checkly_static_salt_v1"  # simple stdlib-only hashing, fine for a local demo app
REMEMBER_ME_SECONDS = 60 * 60 * 24 * 30  # 30 days
ABSENT_STREAK_LOOKBACK = 10  # how many recent rows to scan when computing a streak

# token -> user_id (in-memory sessions; reset when the server restarts)
SESSIONS = {}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_password(password: str) -> str:
    return hashlib.sha256((PASSWORD_SALT + password).encode("utf-8")).hexdigest()


def init_db():
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','teacher','student'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL DEFAULT 0,
            att_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('PRESENT','LATE','ABSENT')),
            marked_by INTEGER,
            UNIQUE(student_id, class_id, att_date),
            FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            year_level TEXT,
            course TEXT
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS class_teachers (
            class_id INTEGER NOT NULL,
            teacher_id INTEGER NOT NULL,
            PRIMARY KEY (class_id, teacher_id),
            FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
            FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE
        )"""
    )
    # A student can be in many classes (and a class has many students).
    conn.execute(
        """CREATE TABLE IF NOT EXISTS class_students (
            class_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            PRIMARY KEY (class_id, student_id),
            FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
            FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
        )"""
    )
    conn.commit()

    # Migration 0: remember when each account was created so the admin view
    # can show the newest sign-ups first. Older accounts keep a NULL value.
    if "created_at" not in [r["name"] for r in conn.execute("PRAGMA table_info(users)")]:
        conn.execute("ALTER TABLE users ADD COLUMN created_at TEXT")
        conn.commit()

    # Migration 1: older versions stored ONE class on the user row. Copy it
    # into class_students so nobody loses their class.
    user_cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)")]
    if "class_id" in user_cols:
        conn.execute(
            """INSERT OR IGNORE INTO class_students (class_id, student_id)
               SELECT class_id, id FROM users
               WHERE role = 'student' AND class_id IS NOT NULL
                 AND class_id IN (SELECT id FROM classes)"""
        )
        conn.commit()

    # Migration 2: attendance is now recorded per class (class_id), so a
    # student in two classes can be Present in one and Absent in the other.
    # Old rows are attached to the student's old class; rows from before
    # classes existed get class_id 0 ("No class") so no history is lost.
    att_cols = [r["name"] for r in conn.execute("PRAGMA table_info(attendance)")]
    if "class_id" not in att_cols:
        has_old_class = "class_id" in user_cols
        class_expr = (
            "COALESCE((SELECT u.class_id FROM users u WHERE u.id = a.student_id), 0)"
            if has_old_class else "0"
        )
        conn.execute("ALTER TABLE attendance RENAME TO attendance_old")
        conn.execute(
            """CREATE TABLE attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                class_id INTEGER NOT NULL DEFAULT 0,
                att_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('PRESENT','LATE','ABSENT')),
                marked_by INTEGER,
                UNIQUE(student_id, class_id, att_date),
                FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
            )"""
        )
        conn.execute(
            f"""INSERT INTO attendance (student_id, class_id, att_date, status, marked_by)
                SELECT a.student_id, {class_expr}, a.att_date, a.status, a.marked_by
                FROM attendance_old a"""
        )
        conn.execute("DROP TABLE attendance_old")
        conn.commit()

    # Seed a default admin account so there's always a way in.
    row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").fetchone()
    if row["c"] == 0:
        conn.execute(
            "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,datetime('now'))",
            ("Administrator", "admin@checkly.com", hash_password("admin123"), "admin"),
        )
        conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------

def parse_date_param(value):
    """Validates a YYYY-MM-DD string. Falls back to today on anything bad,
    and clamps anything in the future back to today - attendance doesn't
    make sense for a day that hasn't happened yet."""
    if not value:
        return date.today().isoformat()
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return date.today().isoformat()
    if parsed > date.today():
        return date.today().isoformat()
    return parsed.isoformat()


def get_students_with_status(conn, att_date, class_id):
    """The roster of ONE class, each student's status in that class on
    att_date, and their consecutive-absence streak in that class."""
    rows = conn.execute(
        """SELECT u.id, u.name, u.email,
                  COALESCE(a.status, 'UNMARKED') AS status
           FROM class_students cs
           JOIN users u ON u.id = cs.student_id
           LEFT JOIN attendance a
                  ON a.student_id = u.id AND a.class_id = cs.class_id AND a.att_date = ?
           WHERE cs.class_id = ?
           ORDER BY u.name""",
        (att_date, class_id),
    ).fetchall()

    students = []
    for r in rows:
        streak_rows = conn.execute(
            """SELECT status FROM attendance
               WHERE student_id = ? AND class_id = ?
               ORDER BY att_date DESC LIMIT ?""",
            (r["id"], class_id, ABSENT_STREAK_LOOKBACK),
        ).fetchall()
        streak = 0
        for sr in streak_rows:
            if sr["status"] == "ABSENT":
                streak += 1
            else:
                break
        student = dict(r)
        student["absentStreak"] = streak
        students.append(student)
    return students


def get_teacher_classes(conn, teacher_id):
    """Classes a teacher is assigned to teach, alphabetical."""
    rows = conn.execute(
        """SELECT c.id, c.name, c.year_level, c.course
           FROM classes c
           JOIN class_teachers ct ON ct.class_id = c.id
           WHERE ct.teacher_id = ?
           ORDER BY c.name""",
        (teacher_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_student_classes(conn, student_id):
    """Every class a student is in, with that class's teachers."""
    rows = conn.execute(
        """SELECT c.id, c.name, c.year_level, c.course
           FROM classes c JOIN class_students cs ON cs.class_id = c.id
           WHERE cs.student_id = ? ORDER BY c.name""",
        (student_id,),
    ).fetchall()
    out = []
    for r in rows:
        c = dict(r)
        c["teachers"] = [
            t["name"] for t in conn.execute(
                """SELECT t.name FROM class_teachers ct JOIN users t ON t.id = ct.teacher_id
                   WHERE ct.class_id = ? ORDER BY t.name""",
                (c["id"],),
            )
        ]
        out.append(c)
    return out


def teacher_teaches_class(conn, teacher_id, class_id):
    if class_id is None:
        return False
    row = conn.execute(
        "SELECT 1 FROM class_teachers WHERE teacher_id = ? AND class_id = ?",
        (teacher_id, class_id),
    ).fetchone()
    return row is not None


def can_mark(conn, user, student_id, class_id):
    """Admins can mark any student in any class they're in. Teachers can
    only mark students in a class they teach. The student must actually
    be in that class."""
    if class_id is None or student_id is None:
        return False
    in_class = conn.execute(
        "SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?",
        (class_id, student_id),
    ).fetchone()
    if not in_class:
        return False
    return user["role"] == "admin" or teacher_teaches_class(conn, user["id"], class_id)


def set_user_classes(conn, user_id, role, class_ids):
    """Replace a user's class memberships. Students go in class_students,
    teachers in class_teachers; admins have none. Unknown ids are ignored."""
    conn.execute("DELETE FROM class_students WHERE student_id = ?", (user_id,))
    conn.execute("DELETE FROM class_teachers WHERE teacher_id = ?", (user_id,))
    if role not in ("student", "teacher"):
        return
    table, col = ("class_students", "student_id") if role == "student" else ("class_teachers", "teacher_id")
    for cid in dict.fromkeys(class_ids or []):  # de-dupe, keep order
        if conn.execute("SELECT 1 FROM classes WHERE id = ?", (cid,)).fetchone():
            conn.execute(f"INSERT OR IGNORE INTO {table} (class_id, {col}) VALUES (?,?)", (cid, user_id))


def clean_id_list(value):
    out = []
    for v in value or []:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            pass
    return out


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class CheeklyHandler(BaseHTTPRequestHandler):
    server_version = "Checkly/1.0"

    # -- small helpers ----------------------------------------------------

    def send_json(self, payload, status=200, set_cookie=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def get_session_token(self):
        raw_cookie = self.headers.get("Cookie")
        if not raw_cookie:
            return None
        jar = cookies.SimpleCookie()
        jar.load(raw_cookie)
        morsel = jar.get("session")
        return morsel.value if morsel else None

    def current_user(self):
        token = self.get_session_token()
        if not token or token not in SESSIONS:
            return None
        user_id = SESSIONS[token]
        conn = get_db()
        user = conn.execute(
            "SELECT id, name, email, role FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user:
            conn.close()
            return None
        result = dict(user)
        if result["role"] == "student":
            names = [c["name"] for c in get_student_classes(conn, user_id)]
        elif result["role"] == "teacher":
            names = [c["name"] for c in get_teacher_classes(conn, user_id)]
        else:
            names = []
        conn.close()
        result["classNames"] = names
        result["className"] = ", ".join(names) if names else None
        return result

    def require_role(self, *roles):
        user = self.current_user()
        if not user:
            self.send_json({"error": "Not logged in."}, 401)
            return None
        if roles and user["role"] not in roles:
            self.send_json({"error": "You don't have permission to do that."}, 403)
            return None
        return user

    # -- routing ------------------------------------------------------------

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api_get(path)
        else:
            self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api_post(path)
        else:
            self.send_json({"error": "Not found"}, 404)

    # -- static file serving -------------------------------------------------

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # prevent path traversal
        safe_path = os.path.normpath(path).lstrip("/\\")
        full_path = os.path.join(BASE_DIR, safe_path)
        if not full_path.startswith(BASE_DIR) or not os.path.isfile(full_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")
            return
        mime, _ = mimetypes.guess_type(full_path)
        mime = mime or "application/octet-stream"
        with open(full_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        if safe_path.replace("\\", "/") == "static/sw.js":
            # sw.js lives in /static/, but needs to control the whole app.
            self.send_header("Service-Worker-Allowed", "/")
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- API: GET -------------------------------------------------------------

    def handle_api_get(self, path):
        query = parse_qs(urlparse(self.path).query)

        if path == "/api/session":
            user = self.current_user()
            if user:
                conn = get_db()
                row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
                conn.close()
                # lets the UI nag until the seeded admin123 password is changed
                user["defaultPassword"] = bool(row) and row["password_hash"] == hash_password("admin123")
            self.send_json({"user": user})
            return

        if path == "/api/students":
            user = self.require_role("teacher", "admin")
            if not user:
                return
            att_date = parse_date_param(query.get("date", [None])[0])
            requested_class_id = query.get("classId", [None])[0]
            requested_class_id = int(requested_class_id) if requested_class_id else None
            conn = get_db()

            if user["role"] == "teacher":
                classes_out = get_teacher_classes(conn, user["id"])
            else:
                classes_out = [dict(r) for r in conn.execute(
                    "SELECT id, name, year_level, course FROM classes ORDER BY name"
                ).fetchall()]
            class_ids = [c["id"] for c in classes_out]
            if not class_ids:
                conn.close()
                self.send_json({
                    "date": att_date,
                    "today": date.today().isoformat(),
                    "students": [],
                    "classes": [],
                    "currentClassId": None,
                })
                return
            current_class_id = requested_class_id if requested_class_id in class_ids else class_ids[0]
            students = get_students_with_status(conn, att_date, current_class_id)
            # tell the teacher which other classes each student shares with them
            for st in students:
                st["otherClasses"] = [
                    r["name"] for r in conn.execute(
                        """SELECT c.name FROM class_students cs JOIN classes c ON c.id = cs.class_id
                           WHERE cs.student_id = ? AND cs.class_id != ? ORDER BY c.name""",
                        (st["id"], current_class_id),
                    )
                ]
            conn.close()
            self.send_json({
                "date": att_date,
                "today": date.today().isoformat(),
                "students": students,
                "classes": classes_out,
                "currentClassId": current_class_id,
            })
            return

        if path == "/api/attendance/me":
            user = self.require_role("student")
            if not user:
                return
            today = date.today().isoformat()
            conn = get_db()
            my_classes = get_student_classes(conn, user["id"])
            names = {c["id"]: c["name"] for c in my_classes}
            for r in conn.execute(
                """SELECT DISTINCT a.class_id, c.name FROM attendance a
                   JOIN classes c ON c.id = a.class_id WHERE a.student_id = ?""",
                (user["id"],),
            ):
                names.setdefault(r["class_id"], r["name"])
            rows = conn.execute(
                """SELECT att_date, status, class_id FROM attendance
                   WHERE student_id = ? ORDER BY att_date DESC, class_id""",
                (user["id"],),
            ).fetchall()
            today_rows = conn.execute(
                "SELECT class_id, status FROM attendance WHERE student_id = ? AND att_date = ?",
                (user["id"], today),
            ).fetchall()
            conn.close()

            records = []
            for r in rows:
                rec = dict(r)
                rec["classId"] = rec.pop("class_id")
                rec["className"] = names.get(rec["classId"], "No class")
                records.append(rec)
            counts = {"PRESENT": 0, "LATE": 0, "ABSENT": 0}
            for r in records:
                if r["status"] in counts:
                    counts[r["status"]] += 1
            percent_present = round(counts["PRESENT"] / len(records) * 100) if records else None

            # today's status per class the student is in (UNMARKED if no row yet)
            today_by_class = {r["class_id"]: r["status"] for r in today_rows}
            today_classes = [
                {"classId": c["id"], "className": c["name"], "status": today_by_class.get(c["id"], "UNMARKED")}
                for c in my_classes
            ]
            # headline status for today: worst marked status wins
            marked = [t["status"] for t in today_classes] or []
            marked += [st for cid, st in today_by_class.items() if cid not in names or cid == 0]
            overall = "UNMARKED"
            for candidate in ("ABSENT", "LATE", "PRESENT"):
                if candidate in marked:
                    overall = candidate
                    break
            self.send_json({
                "date": today,
                "todayStatus": overall,
                "todayByClass": today_classes,
                "records": records,
                "percentPresent": percent_present,
                "counts": counts,
                "classes": [
                    {"id": c["id"], "name": c["name"], "yearLevel": c["year_level"],
                     "course": c["course"], "teachers": c["teachers"]}
                    for c in my_classes
                ],
                "classFilterOptions": [{"id": cid, "name": nm} for cid, nm in sorted(names.items(), key=lambda kv: kv[1])],
            })
            return

        if path == "/api/users":
            user = self.require_role("admin")
            if not user:
                return
            conn = get_db()
            rows = conn.execute(
                """SELECT id, name, email, role, created_at,
                          CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END AS is_new
                   FROM users ORDER BY id DESC"""
            ).fetchall()
            users = [dict(r) for r in rows]
            for u in users:
                u["isNew"] = bool(u.pop("is_new"))
            memberships = {}  # user id -> [{id, name}]
            for r in conn.execute(
                """SELECT cs.student_id AS uid, c.id, c.name FROM class_students cs
                   JOIN classes c ON c.id = cs.class_id
                   UNION ALL
                   SELECT ct.teacher_id AS uid, c.id, c.name FROM class_teachers ct
                   JOIN classes c ON c.id = ct.class_id
                   ORDER BY 3"""
            ):
                memberships.setdefault(r["uid"], []).append({"id": r["id"], "name": r["name"]})
            for u in users:
                u["classes"] = memberships.get(u["id"], []) if u["role"] in ("student", "teacher") else []
            conn.close()
            self.send_json({"users": users})
            return

        if path == "/api/classes":
            user = self.require_role("admin", "teacher")
            if not user:
                return
            conn = get_db()
            if user["role"] == "teacher":
                classes = get_teacher_classes(conn, user["id"])
                conn.close()
                self.send_json({"classes": classes})
                return
            rows = conn.execute(
                "SELECT id, name, year_level, course FROM classes ORDER BY name"
            ).fetchall()
            classes = []
            for r in rows:
                c = dict(r)
                teachers = conn.execute(
                    """SELECT u.id, u.name FROM users u
                       JOIN class_teachers ct ON ct.teacher_id = u.id
                       WHERE ct.class_id = ? ORDER BY u.name""",
                    (c["id"],),
                ).fetchall()
                c["teachers"] = [dict(t) for t in teachers]
                students = conn.execute(
                    """SELECT u.id, u.name FROM users u
                       JOIN class_students cs ON cs.student_id = u.id
                       WHERE cs.class_id = ? ORDER BY u.name""",
                    (c["id"],),
                ).fetchall()
                c["students"] = [dict(st) for st in students]
                c["studentCount"] = len(c["students"])
                classes.append(c)
            conn.close()
            self.send_json({"classes": classes})
            return

        if path == "/api/overview":
            user = self.require_role("admin")
            if not user:
                return
            today = date.today().isoformat()
            conn = get_db()
            counts = conn.execute("SELECT role, COUNT(*) c FROM users GROUP BY role").fetchall()
            today_counts = conn.execute(
                "SELECT status, COUNT(*) c FROM attendance WHERE att_date = ? GROUP BY status", (today,)
            ).fetchall()
            conn.close()
            self.send_json({
                "date": today,
                "userCounts": {r["role"]: r["c"] for r in counts},
                "todayAttendance": {r["status"]: r["c"] for r in today_counts},
            })
            return

        if path == "/api/trends":
            user = self.require_role("admin")
            if not user:
                return
            days = 14
            start = date.today() - timedelta(days=days - 1)
            conn = get_db()
            rows = conn.execute(
                """SELECT att_date, status, COUNT(*) c FROM attendance
                   WHERE att_date >= ? GROUP BY att_date, status""",
                (start.isoformat(),),
            ).fetchall()
            conn.close()
            by_date = {}
            for r in rows:
                by_date.setdefault(r["att_date"], {})[r["status"]] = r["c"]
            series = []
            for i in range(days):
                d = (start + timedelta(days=i)).isoformat()
                counts = by_date.get(d, {})
                series.append({
                    "date": d,
                    "present": counts.get("PRESENT", 0),
                    "late": counts.get("LATE", 0),
                    "absent": counts.get("ABSENT", 0),
                })
            self.send_json({"days": series})
            return

        self.send_json({"error": "Not found"}, 404)

    # -- API: POST --------------------------------------------------------------

    def handle_api_post(self, path):
        body = self.read_json_body()

        if path == "/api/register":
            self.api_register(body)
            return

        if path == "/api/login":
            self.api_login(body)
            return

        if path == "/api/me/password":
            me = self.current_user()
            if not me:
                self.send_json({"error": "Please log in first."}, 401)
                return
            current_password = body.get("currentPassword") or ""
            new_password = body.get("newPassword") or ""
            if len(new_password) < 4:
                self.send_json({"error": "New password must be at least 4 characters."}, 400)
                return
            conn = get_db()
            row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (me["id"],)).fetchone()
            if not row or row["password_hash"] != hash_password(current_password):
                conn.close()
                self.send_json({"error": "Your current password is incorrect."}, 400)
                return
            if new_password == current_password:
                conn.close()
                self.send_json({"error": "Choose a password different from your current one."}, 400)
                return
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(new_password), me["id"]),
            )
            conn.commit()
            conn.close()
            # sign out every other device/browser for this account, keep this one
            keep = self.get_session_token()
            for tok in [t for t, uid in SESSIONS.items() if uid == me["id"] and t != keep]:
                del SESSIONS[tok]
            self.send_json({"ok": True})
            return

        if path == "/api/logout":
            token = self.get_session_token()
            if token in SESSIONS:
                del SESSIONS[token]
            self.send_json({"ok": True})
            return

        if path == "/api/attendance":
            user = self.require_role("teacher", "admin")
            if not user:
                return
            student_id = body.get("studentId")
            class_id = body.get("classId")
            status = body.get("status")
            att_date = parse_date_param(body.get("date"))
            if status not in ("PRESENT", "LATE", "ABSENT"):
                self.send_json({"error": "Invalid status."}, 400)
                return
            conn = get_db()
            if not can_mark(conn, user, student_id, class_id):
                conn.close()
                self.send_json({"error": "That student isn't in one of your classes."}, 403)
                return
            conn.execute(
                """INSERT INTO attendance (student_id, class_id, att_date, status, marked_by)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(student_id, class_id, att_date)
                   DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by""",
                (student_id, class_id, att_date, status, user["id"]),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True, "date": att_date})
            return

        if path == "/api/attendance/mark-all":
            user = self.require_role("teacher", "admin")
            if not user:
                return
            att_date = parse_date_param(body.get("date"))
            class_id = body.get("classId")
            conn = get_db()
            if user["role"] == "teacher" and not teacher_teaches_class(conn, user["id"], class_id):
                conn.close()
                self.send_json({"error": "That's not one of your classes."}, 403)
                return
            students = get_students_with_status(conn, att_date, class_id)
            marked = 0
            for st in students:
                if st["status"] == "UNMARKED":
                    conn.execute(
                        """INSERT INTO attendance (student_id, class_id, att_date, status, marked_by)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(student_id, class_id, att_date)
                   DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by""",
                        (st["id"], class_id, att_date, "PRESENT", user["id"]),
                    )
                    marked += 1
            conn.commit()
            conn.close()
            self.send_json({"ok": True, "date": att_date, "marked": marked})
            return

        if path == "/api/attendance/clear":
            user = self.require_role("teacher", "admin")
            if not user:
                return
            student_id = body.get("studentId")
            class_id = body.get("classId")
            att_date = parse_date_param(body.get("date"))
            conn = get_db()
            if not can_mark(conn, user, student_id, class_id):
                conn.close()
                self.send_json({"error": "That student isn't in one of your classes."}, 403)
                return
            conn.execute(
                "DELETE FROM attendance WHERE student_id = ? AND class_id = ? AND att_date = ?",
                (student_id, class_id, att_date),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True, "date": att_date})
            return

        if path == "/api/users/create":
            user = self.require_role("admin")
            if not user:
                return
            self.create_user(body, allow_admin=True)
            return

        if path == "/api/users/bulk-create":
            user = self.require_role("admin")
            if not user:
                return
            rows = body.get("users") or []
            created = 0
            errors = []
            conn = get_db()
            all_classes = {c["name"].strip().lower(): c["id"] for c in conn.execute("SELECT id, name FROM classes")}
            for i, row in enumerate(rows):
                name = (row.get("name") or "").strip()
                email = (row.get("email") or "").strip().lower()
                password = row.get("password") or ""
                role = row.get("role") or "student"
                # "class" may list several, separated by ; or | (e.g. "Math 10;Science 10")
                raw_classes = (row.get("class") or row.get("classes") or "").strip()
                class_names = [c.strip() for c in raw_classes.replace("|", ";").split(";") if c.strip()]
                label = email or name or f"row {i + 1}"
                if role not in ("admin", "teacher", "student"):
                    errors.append({"row": label, "error": "Invalid role."})
                    continue
                if not name or not email or len(password) < 4:
                    errors.append({"row": label, "error": "Missing name/email or password too short."})
                    continue
                existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
                if existing:
                    errors.append({"row": label, "error": "Email already registered."})
                    continue
                class_ids = []
                if role in ("student", "teacher"):
                    for cn in class_names:
                        cid = all_classes.get(cn.lower())
                        if cid is None:
                            errors.append({"row": label, "error": f"Class '{cn}' doesn't exist - skipped that class."})
                        else:
                            class_ids.append(cid)
                cur = conn.execute(
                    "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,datetime('now'))",
                    (name, email, hash_password(password), role),
                )
                set_user_classes(conn, cur.lastrowid, role, class_ids)
                created += 1
            conn.commit()
            conn.close()
            self.send_json({"ok": True, "created": created, "errors": errors})
            return

        if path == "/api/users/update":
            user = self.require_role("admin")
            if not user:
                return
            target_id = body.get("id")
            name = (body.get("name") or "").strip()
            email = (body.get("email") or "").strip().lower()
            role = body.get("role") or "student"
            # classIds: if the client sends it, replace the person's classes.
            # If omitted, their classes are left alone (unless the role changes).
            class_ids = clean_id_list(body.get("classIds")) if "classIds" in body else None
            if not name or not email:
                self.send_json({"error": "Name and email are required."}, 400)
                return
            if role not in ("admin", "teacher", "student"):
                self.send_json({"error": "Invalid role."}, 400)
                return
            conn = get_db()
            current = conn.execute("SELECT role FROM users WHERE id = ?", (target_id,)).fetchone()
            if not current:
                conn.close()
                self.send_json({"error": "Account not found."}, 404)
                return
            if current["role"] == "admin" and role != "admin":
                if target_id == user["id"]:
                    conn.close()
                    self.send_json({"error": "You can't change your own admin role."}, 400)
                    return
                admins = conn.execute("SELECT COUNT(*) c FROM users WHERE role = 'admin'").fetchone()["c"]
                if admins <= 1:
                    conn.close()
                    self.send_json({"error": "There must be at least one admin."}, 400)
                    return
            clash = conn.execute(
                "SELECT id FROM users WHERE email = ? AND id != ?", (email, target_id)
            ).fetchone()
            if clash:
                conn.close()
                self.send_json({"error": "That email is already registered."}, 400)
                return
            conn.execute(
                "UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?",
                (name, email, role, target_id),
            )
            if class_ids is not None:
                set_user_classes(conn, target_id, role, class_ids)
            elif current["role"] != role:
                # student <-> teacher memberships don't carry over
                set_user_classes(conn, target_id, role, [])
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/classes/create":
            user = self.require_role("admin")
            if not user:
                return
            name = (body.get("name") or "").strip()
            year_level = (body.get("yearLevel") or "").strip()
            course = (body.get("course") or "").strip()
            if not name:
                self.send_json({"error": "Class name is required."}, 400)
                return
            if year_level and year_level not in YEAR_LEVELS:
                self.send_json({"error": "Year level must be 1st to 4th Year."}, 400)
                return
            conn = get_db()
            cur = conn.execute(
                "INSERT INTO classes (name, year_level, course) VALUES (?,?,?)",
                (name, year_level, course),
            )
            conn.commit()
            new_id = cur.lastrowid
            conn.close()
            self.send_json({"ok": True, "id": new_id})
            return

        if path == "/api/classes/update":
            user = self.require_role("admin")
            if not user:
                return
            class_id = body.get("id")
            name = (body.get("name") or "").strip()
            year_level = (body.get("yearLevel") or "").strip()
            course = (body.get("course") or "").strip()
            if not name:
                self.send_json({"error": "Class name is required."}, 400)
                return
            conn = get_db()
            prev = conn.execute("SELECT year_level FROM classes WHERE id = ?", (class_id,)).fetchone()
            # Older classes may hold a value from before (e.g. "Grade 10"); keep it if unchanged.
            if year_level and year_level not in YEAR_LEVELS and not (prev and prev["year_level"] == year_level):
                conn.close()
                self.send_json({"error": "Year level must be 1st to 4th Year."}, 400)
                return
            conn.execute(
                "UPDATE classes SET name = ?, year_level = ?, course = ? WHERE id = ?",
                (name, year_level, course, class_id),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/classes/delete":
            user = self.require_role("admin")
            if not user:
                return
            class_id = body.get("id")
            conn = get_db()
            # Memberships go via ON DELETE CASCADE; attendance has no FK on
            # class_id (so old "no class" rows can exist), so clear it here.
            conn.execute("DELETE FROM attendance WHERE class_id = ?", (class_id,))
            conn.execute("DELETE FROM classes WHERE id = ?", (class_id,))
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/classes/teachers/add":
            user = self.require_role("admin")
            if not user:
                return
            class_id = body.get("classId")
            teacher_id = body.get("teacherId")
            conn = get_db()
            teacher = conn.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'teacher'", (teacher_id,)
            ).fetchone()
            if not teacher:
                conn.close()
                self.send_json({"error": "That user isn't a teacher."}, 400)
                return
            conn.execute(
                "INSERT OR IGNORE INTO class_teachers (class_id, teacher_id) VALUES (?,?)",
                (class_id, teacher_id),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/classes/teachers/remove":
            user = self.require_role("admin")
            if not user:
                return
            class_id = body.get("classId")
            teacher_id = body.get("teacherId")
            conn = get_db()
            conn.execute(
                "DELETE FROM class_teachers WHERE class_id = ? AND teacher_id = ?",
                (class_id, teacher_id),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path in ("/api/classes/students/add", "/api/classes/students/remove"):
            user = self.require_role("admin")
            if not user:
                return
            class_id = body.get("classId")
            student_id = body.get("studentId")
            conn = get_db()
            if path.endswith("/add"):
                student = conn.execute(
                    "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
                ).fetchone()
                klass = conn.execute("SELECT id FROM classes WHERE id = ?", (class_id,)).fetchone()
                if not student or not klass:
                    conn.close()
                    self.send_json({"error": "That student or class doesn't exist."}, 400)
                    return
                conn.execute(
                    "INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?,?)",
                    (class_id, student_id),
                )
            else:
                conn.execute(
                    "DELETE FROM class_students WHERE class_id = ? AND student_id = ?",
                    (class_id, student_id),
                )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        # Same thing from the person's side: add/remove one class for a
        # student OR a teacher without caring which table it lives in.
        if path in ("/api/users/classes/add", "/api/users/classes/remove"):
            user = self.require_role("admin")
            if not user:
                return
            target_id = body.get("userId")
            class_id = body.get("classId")
            conn = get_db()
            target = conn.execute("SELECT role FROM users WHERE id = ?", (target_id,)).fetchone()
            if not target or target["role"] not in ("student", "teacher"):
                conn.close()
                self.send_json({"error": "Only students and teachers can be in classes."}, 400)
                return
            table, col = (
                ("class_students", "student_id") if target["role"] == "student"
                else ("class_teachers", "teacher_id")
            )
            if path.endswith("/add"):
                if not conn.execute("SELECT 1 FROM classes WHERE id = ?", (class_id,)).fetchone():
                    conn.close()
                    self.send_json({"error": "That class doesn't exist."}, 400)
                    return
                conn.execute(f"INSERT OR IGNORE INTO {table} (class_id, {col}) VALUES (?,?)", (class_id, target_id))
            else:
                conn.execute(f"DELETE FROM {table} WHERE class_id = ? AND {col} = ?", (class_id, target_id))
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/users/reset-password":
            user = self.require_role("admin")
            if not user:
                return
            target_id = body.get("id")
            new_password = body.get("newPassword") or ""
            if len(new_password) < 4:
                self.send_json({"error": "Password must be at least 4 characters."}, 400)
                return
            conn = get_db()
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(new_password), target_id),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/users/delete":
            user = self.require_role("admin")
            if not user:
                return
            target_id = body.get("id")
            if target_id == user["id"]:
                self.send_json({"error": "You can't delete your own account."}, 400)
                return
            conn = get_db()
            conn.execute("DELETE FROM users WHERE id = ?", (target_id,))
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        self.send_json({"error": "Not found"}, 404)

    # -- shared account creation logic ---------------------------------------

    def create_user(self, body, allow_admin):
        name = (body.get("name") or "").strip()
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        role = body.get("role") or "student"
        class_ids = clean_id_list(body.get("classIds")) if role in ("student", "teacher") else []

        if role not in ("admin", "teacher", "student"):
            self.send_json({"error": "Invalid role."}, 400)
            return
        if role == "admin" and not allow_admin:
            self.send_json({"error": "Admin accounts require an admin code."}, 403)
            return
        if not name or not email or len(password) < 4:
            self.send_json({"error": "Please fill in name, email, and a password (4+ chars)."}, 400)
            return

        conn = get_db()
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.close()
            self.send_json({"error": "That email is already registered."}, 400)
            return
        for cid in class_ids:
            if not conn.execute("SELECT 1 FROM classes WHERE id = ?", (cid,)).fetchone():
                conn.close()
                self.send_json({"error": "One of those classes doesn't exist."}, 400)
                return
        cur = conn.execute(
            "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,datetime('now'))",
            (name, email, hash_password(password), role),
        )
        set_user_classes(conn, cur.lastrowid, role, class_ids)
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        self.send_json({"ok": True, "id": new_id})

    def api_register(self, body):
        # Public signup can only ever create a student account. Any "role",
        # "adminCode" or "classId" sent by the client is ignored; only an
        # admin can promote an account (see /api/users/update).
        safe_body = {
            "name": body.get("name"),
            "email": body.get("email"),
            "password": body.get("password"),
            "role": "student",
        }
        self.create_user(safe_body, allow_admin=False)

    def api_login(self, body):
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        remember_me = bool(body.get("rememberMe"))
        conn = get_db()
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        conn.close()
        if not user or user["password_hash"] != hash_password(password):
            self.send_json({"error": "Invalid email or password."}, 401)
            return
        token = secrets.token_hex(24)
        SESSIONS[token] = user["id"]
        cookie = f"session={token}; Path=/; HttpOnly; SameSite=Lax"
        if remember_me:
            cookie += f"; Max-Age={REMEMBER_ME_SECONDS}"
        self.send_json(
            {"user": {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}},
            set_cookie=cookie,
        )

    # quiet the default request logging a little
    def log_message(self, fmt, *args):
        print("[checkly]", fmt % args)


def main():
    init_db()
    port = 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), CheeklyHandler)
    print(f"Checkly running at http://localhost:{port}")
    print("Seeded admin login -> admin@checkly.com / admin123")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
