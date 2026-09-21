let allStudents = [];
let myClasses = [];
let currentClassId = null;
let currentDate = null; // ISO date currently being viewed/marked
let todayIso = null;    // the server's notion of "today" - can't navigate past this

document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("teacher");
    if (!user) return;
    wireTopbar(user);

    await loadStudents();

    const search = document.getElementById("student-search");
    search.addEventListener(
        "input",
        debounce(() => renderStudents(visibleStudents()), 150)
    );

    const statusFilter = document.getElementById("student-status-filter");
    statusFilter.addEventListener("change", () => renderStudents(visibleStudents()));

    document.getElementById("class-select").addEventListener("change", (e) => {
        currentClassId = Number(e.target.value);
        loadStudents(currentDate);
    });

    document.getElementById("date-prev").addEventListener("click", () => loadStudents(shiftDate(currentDate, -1)));
    document.getElementById("date-next").addEventListener("click", () => loadStudents(shiftDate(currentDate, 1)));
    document.getElementById("date-today").addEventListener("click", () => loadStudents(todayIso));
    document.getElementById("date-picker").addEventListener("change", (e) => {
        if (e.target.value) loadStudents(e.target.value);
    });

    document.getElementById("mark-all-btn").addEventListener("click", markAllPresent);
    document.getElementById("print-btn").addEventListener("click", () => window.print());
});

function shiftDate(iso, delta) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
}

async function loadStudents(date) {
    const container = document.querySelector(".students-container");
    container.innerHTML = "";
    container.appendChild(skeletonBlocks(6, "skeleton-card"));

    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (currentClassId) params.set("classId", currentClassId);

    try {
        const data = await apiGet(`/api/students?${params.toString()}`);
        allStudents = data.students;
        myClasses = data.classes || [];
        currentClassId = data.currentClassId;
        currentDate = data.date;
        todayIso = data.today;
        updateClassSelect();
        updateDateControls();
    } catch (err) {
        container.innerHTML = "";
        toast(err.message, "error");
        return;
    }

    if (myClasses.length === 0) {
        container.innerHTML = '<div class="empty-state">You haven\'t been assigned to a class yet. Ask an admin to add you to one.</div>';
        renderSummary([]);
        document.getElementById("mark-all-btn").disabled = true;
        return;
    }

    document.getElementById("mark-all-btn").disabled = false;
    renderSummary(allStudents);
    renderStudents(visibleStudents());
}

function updateClassSelect() {
    const select = document.getElementById("class-select");
    if (myClasses.length <= 1) {
        select.hidden = true;
        select.innerHTML = "";
        return;
    }
    select.hidden = false;
    select.innerHTML = myClasses
        .map((c) => `<option value="${c.id}" ${c.id === currentClassId ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
        .join("");
}

function updateDateControls() {
    document.getElementById("date-picker").value = currentDate;
    document.getElementById("date-picker").max = todayIso;
    document.getElementById("date-next").disabled = currentDate >= todayIso;

    const isPast = currentDate !== todayIso;
    document.getElementById("date-today").hidden = !isPast;

    const banner = document.getElementById("past-date-banner");
    if (isPast) {
        banner.hidden = false;
        banner.textContent = `Viewing ${formatDisplayDate(currentDate)} - changes here update that day's records, not today's.`;
    } else {
        banner.hidden = true;
    }
}

// Applies the current search term and status filter together, so either
// control can change without the other one's setting getting lost.
function visibleStudents() {
    const search = document.getElementById("student-search");
    const statusFilter = document.getElementById("student-status-filter");
    let list = filterBySearch(allStudents, search ? search.value : "");
    list = filterByStatus(list, statusFilter ? statusFilter.value : "all");
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
}

function filterBySearch(students, term) {
    const t = (term || "").trim().toLowerCase();
    if (!t) return students;
    return students.filter(
        (s) => s.name.toLowerCase().includes(t) || s.email.toLowerCase().includes(t)
    );
}

function filterByStatus(students, status) {
    if (!status || status === "all") return students;
    return students.filter((s) => s.status === status);
}

function renderSummary(students) {
    const summaryEl = document.querySelector(".today-summary");
    const counts = { PRESENT: 0, LATE: 0, ABSENT: 0, UNMARKED: 0 };
    for (const s of students) counts[s.status] = (counts[s.status] || 0) + 1;

    summaryEl.innerHTML = `
        <div class="stat-card stat-present"><div class="stat-value">${counts.PRESENT}</div><div class="stat-label">Present</div></div>
        <div class="stat-card stat-late"><div class="stat-value">${counts.LATE}</div><div class="stat-label">Late</div></div>
        <div class="stat-card stat-absent"><div class="stat-value">${counts.ABSENT}</div><div class="stat-label">Absent</div></div>
        <div class="stat-card stat-unmarked"><div class="stat-value">${counts.UNMARKED}</div><div class="stat-label">Unmarked</div></div>
    `;
}

function renderStudents(students) {
    const container = document.querySelector(".students-container");
    container.innerHTML = "";

    if (students.length === 0) {
        container.innerHTML = '<div class="empty-state">No students match your search and filter.</div>';
        return;
    }

    for (const student of students) {
        container.appendChild(renderStudentCard(student));
    }
}

async function markAllPresent() {
    const btn = document.getElementById("mark-all-btn");
    btn.disabled = true;
    try {
        const result = await apiPost("/api/attendance/mark-all", { date: currentDate, classId: currentClassId });
        if (result.marked > 0) {
            toast(`Marked ${result.marked} student${result.marked === 1 ? "" : "s"} present.`);
        } else {
            toast("Everyone already has a status today.");
        }
        await loadStudents(currentDate);
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
    }
}

function renderStudentCard(student) {
    const card = document.createElement("div");
    card.className = "student-profiles";

    const streakBadge =
        student.absentStreak >= 3
            ? `<div class="streak-badge" title="${student.absentStreak} absences in a row">&#128293; ${student.absentStreak}</div>`
            : "";

    card.innerHTML = `
        ${streakBadge}
        <div class="student-profile-cover"></div>
        <img class="student-profile-img" src="${avatarUrl(student)}" alt="${escapeHtml(student.name)}" loading="lazy">
        <div class="student-name">${escapeHtml(student.name)}</div>
        <div class="student-attendance status-${student.status}">${student.status}</div>
        <div class="attendance-actions">
            <button data-status="PRESENT" class="mark-btn present-btn">Present</button>
            <button data-status="LATE" class="mark-btn late-btn">Late</button>
            <button data-status="ABSENT" class="mark-btn absent-btn">Absent</button>
        </div>
    `;

    card.querySelectorAll(".mark-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const previousStatus = student.status;
            const newStatus = btn.dataset.status;
            btn.disabled = true;
            try {
                await apiPost("/api/attendance", { studentId: student.id, status: newStatus, date: currentDate });
                toast(
                    `${student.name} marked ${newStatus.toLowerCase()}.`,
                    "ok",
                    "Undo",
                    () => undoMark(student.id, previousStatus)
                );
                await loadStudents(currentDate);
            } catch (err) {
                toast(err.message, "error");
            } finally {
                btn.disabled = false;
            }
        });
    });

    return card;
}

async function undoMark(studentId, previousStatus) {
    try {
        if (previousStatus === "UNMARKED") {
            await apiPost("/api/attendance/clear", { studentId, date: currentDate });
        } else {
            await apiPost("/api/attendance", { studentId, status: previousStatus, date: currentDate });
        }
        toast("Reverted.");
        await loadStudents(currentDate);
    } catch (err) {
        toast(err.message, "error");
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// Nobody uploads real photos in this demo app, so give every student a
// stable, distinct-looking initials avatar instead of a blank/empty card.
// Seeded on their email so the same student always gets the same avatar.
function avatarUrl(student) {
    const seed = encodeURIComponent(student.email || student.name || String(student.id));
    return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&backgroundType=gradientLinear`;
}
