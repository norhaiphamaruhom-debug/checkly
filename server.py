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
    admin   - manage all accounts (create/delete teachers & students), view all attendance
    teacher - view students, mark today's attendance (Present / Late / Absent)
    student - view their own attendance history
"""

import hashlib
import json
import mimetypes
import os
import secrets
import sqlite3
from datetime import date
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "checkly.db")
ADMIN_SIGNUP_CODE = "CHECKLY-ADMIN-2026"  # required to self-register as an admin
PASSWORD_SALT = "checkly_static_salt_v1"  # simple stdlib-only hashing, fine for a local demo app

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
        user = conn.execute("SELECT id, name, email, role FROM users WHERE id = ?", (user_id,)).fetchone()
        conn.close()
        return dict(user) if user else None

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
        if path == "/api/session":
            user = self.current_user()
            self.send_json({"user": user})
            return

        if path == "/api/students":
            user = self.require_role("teacher", "admin")
            if not user:
                return
            today = date.today().isoformat()
            conn = get_db()
            rows = conn.execute(
                """SELECT u.id, u.name, u.email,
                          COALESCE(a.status, 'UNMARKED') AS status
                   FROM users u
                   LEFT JOIN attendance a ON a.student_id = u.id AND a.att_date = ?
                   WHERE u.role = 'student'
                   ORDER BY u.name""",
                (today,),
            ).fetchall()
            conn.close()
            self.send_json({"date": today, "students": [dict(r) for r in rows]})
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
            self.send_json({
                "date": today,
                "todayStatus": today_row["status"] if today_row else "UNMARKED",
                "records": [dict(r) for r in rows],
            })
            return

        if path == "/api/users":
            user = self.require_role("admin")
            if not user:
                return
            conn = get_db()
            rows = conn.execute("SELECT id, name, email, role FROM users ORDER BY role, name").fetchall()
            conn.close()
            self.send_json({"users": [dict(r) for r in rows]})
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
            if status not in ("PRESENT", "LATE", "ABSENT"):
                self.send_json({"error": "Invalid status."}, 400)
                return
            today = date.today().isoformat()
            conn = get_db()
            conn.execute(
                """INSERT INTO attendance (student_id, att_date, status, marked_by)
                   VALUES (?,?,?,?)
                   ON CONFLICT(student_id, att_date)
                   DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by""",
                (student_id, today, status, user["id"]),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return

        if path == "/api/users/create":
            user = self.require_role("admin")
            if not user:
                return
            self.create_user(body, allow_admin=True)
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
        cur = conn.execute(
            "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
            (name, email, hash_password(password), role),
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
        conn = get_db()
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        conn.close()
        if not user or user["password_hash"] != hash_password(password):
            self.send_json({"error": "Invalid email or password."}, 401)
            return
        token = secrets.token_hex(24)
        SESSIONS[token] = user["id"]
        cookie = f"session={token}; Path=/; HttpOnly; SameSite=Lax"
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
