# Checkly - Student Attendance System

A small full-stack attendance app with three roles: **Admin**, **Teacher**, and **Student**.
The backend is pure Python standard library (no `pip install` needed) using SQLite for storage.

## Run it

```
python3 server.py
```

Then open **http://localhost:8000** in your browser.

A `checkly.db` SQLite file is created automatically next to `server.py` the first time you run it.

## Logging in

A default admin account is seeded automatically:

- **Email:** admin@checkly.com
- **Password:** admin123

From there:

1. Log in as admin and use **Add account** to create teacher and student accounts
   (or let people self-register on the "Create Account" page).
2. Log in as a **teacher** to see the student roster and mark each student
   Present / Late / Absent for today.
3. Log in as a **student** to see your own attendance history.

## Roles & permissions

| Role    | Can do |
|---------|--------|
| Admin   | Create/delete any account (admin, teacher, student), see stats for all users and today's attendance |
| Teacher | View all students, mark today's attendance for any student |
| Student | View only their own attendance history |

## Self-registration

Anyone can create a Student or Teacher account from the "Create Account" page.
Registering as an **Admin** requires an admin code (set in `server.py` as
`ADMIN_SIGNUP_CODE`, default: `CHECKLY-ADMIN-2026`) — change this before
deploying anywhere real. Admins can also just create accounts directly for
teachers and students from the Admin dashboard, no code needed.

## File map

```
server.py          Python stdlib HTTP server: auth, sessions, SQLite, all /api/* routes
checkly.db          created automatically (SQLite database)
index.html          Login page
register.html       Account creation page (role picker)
admin.html          Admin dashboard (stats, user management)
teacher.html        Teacher dashboard (mark attendance)
student.html        Student dashboard (own attendance history)
static/style.css    Shared styling (extends the original theme)
static/app.js       Shared fetch helpers, session guard, logout wiring
static/login.js     Login form logic
static/register.js  Registration form logic
static/admin.js     Admin dashboard logic
static/teacher.js   Teacher dashboard logic
static/student.js   Student dashboard logic
```

## Notes

- Sessions are simple in-memory tokens stored in an HttpOnly cookie; they reset
  if you restart the server (everyone gets logged out, no data is lost).
- The original custom fonts and icon images referenced in the CSS aren't
  included — the site just falls back to a normal font/plain button, so
  nothing breaks. Drop your own font files into `static/fonts/` and an icon
  into `static/icons/` if you want to restore the original look.
