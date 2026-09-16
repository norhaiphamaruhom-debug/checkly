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

1. Log in as admin and use **Add account** (one at a time, or **Bulk import**
   from a CSV) to create teacher and student accounts - or let people
   self-register on the "Create Account" page.
2. Log in as a **teacher** to see the student roster and mark each student
   Present / Late / Absent - for today or any past day.
3. Log in as a **student** to see your own attendance history, percentage,
   and a calendar view.

## Roles & permissions

| Role    | Can do |
|---------|--------|
| Admin   | Create, edit, delete, and reset passwords for any account; bulk-import accounts from CSV; see stats and a 14-day attendance trend chart for the whole school |
| Teacher | View all students, mark attendance (present/late/absent) for today or any past date, mark everyone unmarked as present in one click, undo a mark, see who's on an absence streak |
| Student | View their own attendance history and percentage, switch between a list and a calendar view, export their history as CSV |

## Feature tour

- **Past dates** - the teacher dashboard has a date picker with prev/next
  arrows. Attendance can be viewed or corrected for any day up to today
  (future dates aren't allowed). A banner reminds you when you're not
  looking at today.
- **Mark all present** - one click marks everyone who isn't marked yet as
  present, without touching anyone already marked late/absent.
- **Undo** - the toast shown after marking a student includes an "Undo"
  button for a few seconds, which reverts to whatever the status was before
  (including back to unmarked).
- **Absence streaks** - a small badge appears on a student's card once
  they've been absent 3 or more days in a row (looking at their most
  recent marked days).
- **Search + filter** - the teacher roster can be searched by name/email and
  filtered to show only one status at a time (absent/unmarked/late/present).
- **Student percentage & calendar** - the student dashboard shows a
  "% present" stat and a month calendar with color-coded days, alongside
  the existing list view.
- **CSV export** - students can download their own attendance history;
  admins can bulk-import new accounts from a CSV (`name,email,password,role`
  per row, with or without a header row).
- **Admin editing** - accounts can be edited in place (name/email/role) and
  passwords can be reset from the accounts table, not just created/deleted.
- **Trends chart** - the admin overview includes a 14-day present/late/absent
  chart across the whole school.
- **Remember me** - checking it on login keeps the session for 30 days
  instead of just until the browser closes.
- **Installable** - Checkly has a web app manifest and a minimal service
  worker, so it can be added to a phone's home screen and opened like a
  native app.
- **Print-friendly roster** - the teacher page has a "Print roster" button
  that produces a clean, card-free printout for a paper backup.

## Self-registration

Anyone can create a Student or Teacher account from the "Create Account" page.
Registering as an **Admin** requires an admin code (set in `server.py` as
`ADMIN_SIGNUP_CODE`, default: `CHECKLY-ADMIN-2026`) — change this before
deploying anywhere real. Admins can also just create accounts directly for
teachers and students from the Admin dashboard, no code needed.

## File map

```
server.py                     Python stdlib HTTP server: auth, sessions, SQLite, all /api/* routes
checkly.db                    created automatically (SQLite database)
index.html                    Login page (with Remember me)
register.html                 Account creation page (role picker)
admin.html                    Admin dashboard (stats, trends, user management, bulk import)
teacher.html                  Teacher dashboard (date picker, mark attendance, print)
student.html                  Student dashboard (history, percentage, calendar)
static/style.css              Shared styling (notebook/chalkboard theme)
static/app.js                 Shared fetch helpers, session guard, toast w/ undo, CSV export, skeletons, PWA registration
static/login.js               Login form logic
static/register.js            Registration form logic
static/admin.js                Admin dashboard logic (edit/reset/import/trends)
static/teacher.js             Teacher dashboard logic (dates/mark-all/undo/streaks)
static/student.js             Student dashboard logic (history/percentage/calendar/export)
static/manifest.json          Web app manifest (installable to home screen)
static/sw.js                  Minimal service worker (enables install; no offline caching)
static/icons/                 App icons used by the manifest and browser tab
```

## Notes

- Sessions are simple in-memory tokens stored in an HttpOnly cookie; they
  reset if you restart the server (everyone gets logged out, no data is
  lost). "Remember me" just changes the cookie's lifetime in the browser -
  it doesn't change how sessions are stored on the server.
- Attendance for a given student+day is a single row, upserted by date -
  marking it again (today or in the past) overwrites the previous status
  for that day, which is what both "undo" and correcting a past day rely on.
- The original custom fonts and icon images referenced in the very first
  version of this project aren't included; the app now ships its own
  Google Fonts (Caveat + Nunito) and its own generated icon set instead.
