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
ADMIN_SIGNUP_CODE = "CHECKLY-ADMIN-2026"  # required to self-register as an admin
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
            att_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('PRESENT','LATE','ABSENT')),
            marked_by INTEGER,
            UNIQUE(student_id, att_date),
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
    conn.commit()

    # Migration: older databases won't have this column yet. A student's
    # class_id is NULL until an admin assigns them to a class.
    user_cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)")]
    if "class_id" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN class_id INTEGER REFERENCES classes(id)")
        conn.commit()

    # Seed a default admin account so there's always a way in.
    row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").fetchone()
    if row["c"] == 0:
        conn.execute(
            "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
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


def get_students_with_status(conn, att_date, class_id=None):
    """Every student, their status on att_date, and their current
    consecutive-absence streak (looking backwards from their most recent
    marked day). Pass class_id to restrict to one class's roster."""
    query = """SELECT u.id, u.name, u.email, u.class_id,
                      COALESCE(a.status, 'UNMARKED') AS status
               FROM users u
               LEFT JOIN attendance a ON a.student_id = u.id AND a.att_date = ?
               WHERE u.role = 'student'"""
    params = [att_date]
    if class_id is not None:
        query += " AND u.class_id = ?"
        params.append(class_id)
    query += " ORDER BY u.name"
    rows = conn.execute(query, params).fetchall()

    students = []
    for r in rows:
        streak_rows = conn.execute(
            "SELECT status FROM attendance WHERE student_id = ? ORDER BY att_date DESC LIMIT ?",
            (r["id"], ABSENT_STREAK_LOOKBACK),
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


def teacher_teaches_class(conn, teacher_id, class_id):
    if class_id is None:
        return False
    row = conn.execute(
        "SELECT 1 FROM class_teachers WHERE teacher_id = ? AND class_id = ?",
        (teacher_id, class_id),
    ).fetchone()
    return row is not None


def teacher_can_access_student(conn, user, student_id):
    """Admins can act on any student. Teachers can only act on students in
    a class they're assigned to teach."""
    if user["role"] == "admin":
        return True
    row = conn.execute(
        """SELECT 1 FROM users u
           JOIN class_teachers ct ON ct.class_id = u.class_id
           WHERE u.id = ? AND ct.teacher_id = ?""",
        (student_id, user["id"]),
    ).fetchone()
    return row is not None


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
            """SELECT u.id, u.name, u.email, u.role, c.name AS class_name
               FROM users u LEFT JOIN classes c ON c.id = u.class_id
               WHERE u.id = ?""",
            (user_id,),
        ).fetchone()
        conn.close()
        if not user:
            return None
        result = dict(user)
        result["className"] = result.pop("class_name")
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
        self.end_headers()
        self.wfile.write(data)

    # -- API: GET -------------------------------------------------------------

    def handle_api_get(self, path):
        query = parse_qs(urlparse(self.path).query)

        if path == "/api/session":
            user = self.current_user()
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
                teacher_classes = get_teacher_classes(conn, user["id"])
                class_ids = [c["id"] for c in teacher_classes]
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
                students = get_students_with_status(conn, att_date, class_id=current_class_id)
                classes_out = teacher_classes
            else:
                # Admin: optionally scope to one class, otherwise see everyone.
                current_class_id = requested_class_id
                students = get_students_with_status(conn, att_date, class_id=current_class_id)
                classes_out = [dict(r) for r in conn.execute(
                    "SELECT id, name, year_level, course FROM classes ORDER BY name"
                ).fetchall()]

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
            rows = conn.execute(
                "SELECT att_date, status FROM attendance WHERE student_id = ? ORDER BY att_date DESC",
                (user["id"],),
            ).fetchall()
            today_row = conn.execute(
                "SELECT status FROM attendance WHERE student_id = ? AND att_date = ?",
                (user["id"], today),
            ).fetchone()
            conn.close()
            records = [dict(r) for r in rows]
            present_count = sum(1 for r in records if r["status"] == "PRESENT")
            percent_present = round(present_count / len(records) * 100) if records else None
            self.send_json({
                "date": today,
                "todayStatus": today_row["status"] if today_row else "UNMARKED",
                "records": records,
                "percentPresent": percent_present,
            })
            return

        if path == "/api/users":
            user = self.require_role("admin")
            if not user:
                return
            conn = get_db()
            rows = conn.execute(
                """SELECT u.id, u.name, u.email, u.role, u.class_id, c.name AS class_name
                   FROM users u LEFT JOIN classes c ON c.id = u.class_id
                   ORDER BY u.role, u.name"""
            ).fetchall()
            users = [dict(r) for r in rows]
            teacher_ids = [u["id"] for u in users if u["role"] == "teacher"]
            teaching = {}
            if teacher_ids:
                placeholders = ",".join("?" * len(teacher_ids))
                for r in conn.execute(
                    f"""SELECT ct.teacher_id, c.name FROM class_teachers ct
                        JOIN classes c ON c.id = ct.class_id
                        WHERE ct.teacher_id IN ({placeholders})
                        ORDER BY c.name""",
                    teacher_ids,
                ):
                    teaching.setdefault(r["teacher_id"], []).append(r["name"])
            for u in users:
                if u["role"] == "teacher":
                    u["classNames"] = teaching.get(u["id"], [])
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
                c["studentCount"] = conn.execute(
                    "SELECT COUNT(*) c FROM users WHERE role = 'student' AND class_id = ?", (c["id"],)
                ).fetchone()["c"]
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
            status = body.get("status")
            att_date = parse_date_param(body.get("date"))
            if status not in ("PRESENT", "LATE", "ABSENT"):
                self.send_json({"error": "Invalid status."}, 400)
                return
            conn = get_db()
            if not teacher_can_access_student(conn, user, student_id):
                conn.close()
                self.send_json({"error": "That student isn't in one of your classes."}, 403)
                return
            conn.execute(
                """INSERT INTO attendance (student_id, att_date, status, marked_by)
                   VALUES (?,?,?,?)
                   ON CONFLICT(student_id, att_date)
                   DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by""",
                (student_id, att_date, status, user["id"]),
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
            students = get_students_with_status(conn, att_date, class_id=class_id)
            marked = 0
            for s in students:
                if s["status"] == "UNMARKED":
                    conn.execute(
                        """INSERT INTO attendance (student_id, att_date, status, marked_by)
                           VALUES (?,?,?,?)
                           ON CONFLICT(student_id, att_date)
                           DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by""",
                        (s["id"], att_date, "PRESENT", user["id"]),
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
            att_date = parse_date_param(body.get("date"))
            conn = get_db()
            if not teacher_can_access_student(conn, user, student_id):
                conn.close()
                self.send_json({"error": "That student isn't in one of your classes."}, 403)
                return
            conn.execute(
                "DELETE FROM attendance WHERE student_id = ? AND att_date = ?",
                (student_id, att_date),
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
                class_name = (row.get("class") or "").strip()
                label = email or name or f"row {i + 1}"
                if role not in ("admin", "teacher", "student"):
                    errors.append({"row": label, "error": "Invalid role."})
                    continue
                if not name or not email or len(password) < 4:
                    errors.append({"row": label, "error": "Missing name/email or password too short."})
                    continue
                class_id = None
                if role == "student" and class_name:
                    class_id = all_classes.get(class_name.lower())
                    if class_id is None:
                        errors.append({"row": label, "error": f"Class '{class_name}' doesn't exist - created without a class."})
                existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
                if existing:
                    errors.append({"row": label, "error": "Email already registered."})
                    continue
                conn.execute(
                    "INSERT INTO users (name, email, password_hash, role, class_id) VALUES (?,?,?,?,?)",
                    (name, email, hash_password(password), role, class_id),
                )
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
            # classId is only meaningful for students; null/omitted clears it.
            class_id = body.get("classId") if role == "student" else None
            if not name or not email:
                self.send_json({"error": "Name and email are required."}, 400)
                return
            if role not in ("admin", "teacher", "student"):
                self.send_json({"error": "Invalid role."}, 400)
                return
            conn = get_db()
            clash = conn.execute(
                "SELECT id FROM users WHERE email = ? AND id != ?", (email, target_id)
            ).fetchone()
            if clash:
                conn.close()
                self.send_json({"error": "That email is already registered."}, 400)
                return
            if class_id is not None:
                exists = conn.execute("SELECT id FROM classes WHERE id = ?", (class_id,)).fetchone()
                if not exists:
                    conn.close()
                    self.send_json({"error": "That class doesn't exist."}, 400)
                    return
            conn.execute(
                "UPDATE users SET name = ?, email = ?, role = ?, class_id = ? WHERE id = ?",
                (name, email, role, class_id, target_id),
            )
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
            # Unassign students first - the FK would otherwise block deletion.
            conn.execute("UPDATE users SET class_id = NULL WHERE class_id = ?", (class_id,))
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
        class_id = body.get("classId") if role == "student" else None

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
        if class_id is not None:
            exists = conn.execute("SELECT id FROM classes WHERE id = ?", (class_id,)).fetchone()
            if not exists:
                conn.close()
                self.send_json({"error": "That class doesn't exist."}, 400)
                return
        cur = conn.execute(
            "INSERT INTO users (name, email, password_hash, role, class_id) VALUES (?,?,?,?,?)",
            (name, email, hash_password(password), role, class_id),
        )
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        self.send_json({"ok": True, "id": new_id})

    def api_register(self, body):
        role = body.get("role") or "student"
        admin_code = body.get("adminCode") or ""
        allow_admin = role != "admin" or admin_code == ADMIN_SIGNUP_CODE
        if role == "admin" and not allow_admin:
            self.send_json({"error": "Invalid admin code."}, 403)
            return
        self.create_user(body, allow_admin=True)

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
