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
   self-register as students on the "Create Account" page and promote them
   as needed.
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

## Navigation

- **Admin:** an always-visible tab bar (Overview / Classes / People / Add) - a bottom bar on
  phones, a row of pills on desktop. The Students/Teachers/Admins numbers on the Overview are
  buttons that jump to that filtered list.
- **Teacher:** your classes are tabs above the roster (one tap to switch; with more than 6
  classes it falls back to a dropdown). The last class you used is remembered.
- **Everyone:** a labeled **Log out** button in the top bar; the burger menu still has
  Change password and the extra actions.

## Classes: many-to-many

- A **student** can be in several classes, and a **teacher** can teach several classes.
- A class can have several **teachers** and several **students**.
- Attendance is recorded **per class per day**, so a student can be Present in Math
  and Absent in Science on the same day. Teachers only see/mark the classes they teach
  (use the class dropdown on the teacher page).
- Admin > **People**: every student/teacher row has class chips (x to remove) and a
  "+ Add class" dropdown. Admin > **Classes**: each card lists teachers and students
  with the same add/remove controls.
- Students see all their classes (with teachers and today's status per class), and can
  filter their history, stats, calendar and CSV export by class.
- CSV import: put several classes in the `class` column separated by `;`
  (e.g. `Math 10;Science 10`). Works for students and teachers.
- Upgrading an existing database is automatic on first start: each student's old single
  class becomes a membership, and old attendance is attached to that class (records from
  before classes existed show as "No class").

## Changing your password

Every role has **Change password** in the menu (burger icon). You enter your
current password and the new one twice; other devices signed in to the same
account are logged out, while the one you're using stays signed in. While the
seeded `admin123` password is still in use, a banner reminds you to change it
until you do.

## Self-registration

Anyone can create an account from the "Create Account" page, but self-signup
always creates a **Student**. Signing up is two steps: fill in the form (name, email,
password typed twice), then a **Check your details** screen shows everything back
(password masked, with a Show button). Nothing is saved until they press **Create account**,
and **Go back and edit** keeps what they typed. If the email is already taken they're sent
back to the form with the error. After creating the account they land on the login page
with their email filled in. Only an admin can promote an account to Teacher
or Admin (Admin dashboard > Accounts > Edit > Role). There is no admin signup
code any more.

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
static/sw.js                  Minimal service worker (enables install; no offline caching; scope set to / by server.py)
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
  the Nunito font from Google Fonts (Arial/Segoe UI as fallback) and its own generated icon set instead.
