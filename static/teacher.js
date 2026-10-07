let allStudents = [];
let myClasses = [];
let currentClassId = null;
let currentDate = null; // ISO date currently being viewed/marked
let rosterLayout = readLayoutPref(); // "rows" | "cards"
let todayIso = null;    // the server's notion of "today" - can't navigate past this

document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("teacher");
    if (!user) return;
    wireTopbar(user);

    currentClassId = readLastClass(); // server falls back to the first class if it's no longer valid
    await loadStudents();

    document.getElementById("class-tabs").addEventListener("click", (e) => {
        const tab = e.target.closest("[data-class-tab]");
        if (!tab) return;
        currentClassId = Number(tab.dataset.classTab);
        loadStudents(currentDate);
    });

    const search = document.getElementById("student-search");
    search.addEventListener(
        "input",
        debounce(() => renderStudents(visibleStudents()), 150)
    );

    const statusFilter = document.getElementById("student-status-filter");
    statusFilter.addEventListener("change", () => {
        renderSummary(allStudents);
        renderStudents(visibleStudents());
    });

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

    document.getElementById("layout-rows-btn").addEventListener("click", () => setLayout("rows"));
    document.getElementById("layout-cards-btn").addEventListener("click", () => setLayout("cards"));
    syncLayoutButtons();

    document.getElementById("mark-all-btn").addEventListener("click", markAllPresent);
    document.getElementById("print-btn").addEventListener("click", () => window.print());
});

function shiftDate(iso, delta) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
}

function readLayoutPref() {
    try {
        return localStorage.getItem("checkly-roster-layout") === "cards" ? "cards" : "rows";
    } catch (e) {
        return "rows";
    }
}

function setLayout(layout) {
    rosterLayout = layout;
    try { localStorage.setItem("checkly-roster-layout", layout); } catch (e) { /* ignore */ }
    syncLayoutButtons();
    renderStudents(visibleStudents());
}

function syncLayoutButtons() {
    document.getElementById("layout-rows-btn").classList.toggle("active", rosterLayout === "rows");
    document.getElementById("layout-cards-btn").classList.toggle("active", rosterLayout === "cards");
}

// silent = refresh the data without blanking the list, so marking a student
// doesn't flash skeletons or lose the teacher's scroll position.
async function loadStudents(date, silent = false) {
    const container = document.querySelector(".students-container");
    if (!silent) {
        container.innerHTML = "";
        container.appendChild(skeletonBlocks(6, "skeleton-card"));
    }

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
        document.getElementById("progress-wrap").hidden = true;
        return;
    }

    document.getElementById("mark-all-btn").disabled = false;
    renderSummary(allStudents);
    renderStudents(visibleStudents());
}

function readLastClass() {
    try {
        const v = Number(localStorage.getItem("checkly-last-class"));
        return v || null;
    } catch (e) {
        return null;
    }
}

const MAX_CLASS_TABS = 6; // beyond this, tabs would wrap badly - use the dropdown

function updateClassSelect() {
    const select = document.getElementById("class-select");
    const label = document.getElementById("class-label");
    const tabs = document.getElementById("class-tabs");
    try { if (currentClassId) localStorage.setItem("checkly-last-class", currentClassId); } catch (e) { /* ignore */ }

    // 2-6 classes: always-visible tabs, one tap to switch.
    if (myClasses.length > 1 && myClasses.length <= MAX_CLASS_TABS) {
        select.hidden = true;
        label.hidden = true;
        tabs.hidden = false;
        tabs.innerHTML = myClasses
            .map((c) => `<button type="button" role="tab" class="class-tab ${c.id === currentClassId ? "active" : ""}" aria-selected="${c.id === currentClassId}" data-class-tab="${c.id}">${escapeHtml(c.name)}</button>`)
            .join("");
        return;
    }
    tabs.hidden = true;
    if (myClasses.length <= 1) {
        select.hidden = true;
        select.innerHTML = "";
        label.hidden = myClasses.length === 0;
        label.textContent = myClasses[0] ? myClasses[0].name : "";
        return;
    }
    label.hidden = true;
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

    const filterEl = document.getElementById("student-status-filter");
    const active = filterEl ? filterEl.value : "all";
    const card = (key, cls, label) => `
        <button type="button" class="stat-card stat-filter ${cls} ${active === key ? "is-active" : ""}"
                data-stat-filter="${key}" aria-pressed="${active === key}" title="Show only ${label.toLowerCase()}">
            <div class="stat-value">${counts[key]}</div><div class="stat-label">${label}</div>
        </button>`;

    summaryEl.innerHTML =
        card("PRESENT", "stat-present", "Present") +
        card("LATE", "stat-late", "Late") +
        card("ABSENT", "stat-absent", "Absent") +
        card("UNMARKED", "stat-unmarked", "Unmarked");

    summaryEl.querySelectorAll("[data-stat-filter]").forEach((btn) =>
        btn.addEventListener("click", () => {
            const key = btn.dataset.statFilter;
            // tapping the active card again clears the filter
            filterEl.value = filterEl.value === key ? "all" : key;
            renderSummary(allStudents);
            renderStudents(visibleStudents());
        })
    );

    const wrap = document.getElementById("progress-wrap");
    const total = students.length;
    if (total === 0) {
        wrap.hidden = true;
    } else {
        const marked = total - counts.UNMARKED;
        wrap.hidden = false;
        document.getElementById("progress-text").textContent =
            counts.UNMARKED === 0 ? `All ${total} students marked` : `${marked} of ${total} marked`;
        document.getElementById("progress-fill").style.width = `${Math.round((marked / total) * 100)}%`;
    }
}

function renderStudents(students) {
    const container = document.querySelector(".students-container");
    container.innerHTML = "";
    container.classList.toggle("roster-rows", rosterLayout === "rows");

    if (students.length === 0) {
        container.innerHTML = '<div class="empty-state">No students match your search and filter.</div>';
        return;
    }

    for (const student of students) {
        container.appendChild(rosterLayout === "rows" ? renderStudentRow(student) : renderStudentCard(student));
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
        await loadStudents(currentDate, true);
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
    }
}

// Shared by the row and card layouts: wires the Present/Late/Absent buttons.
function wireMarkButtons(root, student) {
    root.querySelectorAll(".mark-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const previousStatus = student.status;
            const newStatus = btn.dataset.status;
            btn.disabled = true;
            try {
                await apiPost("/api/attendance", { studentId: student.id, classId: currentClassId, status: newStatus, date: currentDate });
                // update in place first so the list reacts instantly
                student.status = newStatus;
                renderSummary(allStudents);
                renderStudents(visibleStudents());
                toast(
                    `${student.name} marked ${newStatus.toLowerCase()}.`,
                    "ok",
                    "Undo",
                    () => undoMark(student.id, previousStatus, currentClassId)
                );
                await loadStudents(currentDate, true); // quietly refresh streaks etc.
            } catch (err) {
                toast(err.message, "error");
                btn.disabled = false;
            }
        });
    });
}

function initialsOf(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function avatarHue(student) {
    const seed = student.email || student.name || String(student.id);
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
    return hash;
}

function renderStudentRow(student) {
    const row = document.createElement("div");
    row.className = "roster-row";
    const streak =
        student.absentStreak >= 3
            ? `<span class="streak-chip" title="${student.absentStreak} absences in a row">&#128293; ${student.absentStreak}</span>`
            : "";
    row.innerHTML = `
        <div class="roster-avatar" style="background:hsl(${avatarHue(student)} 35% 38%)" aria-hidden="true">${escapeHtml(initialsOf(student.name))}</div>
        <div class="roster-main">
            <div class="roster-name"${student.otherClasses && student.otherClasses.length ? ` title="Also in: ${escapeHtml(student.otherClasses.join(", "))}"` : ""}>${escapeHtml(student.name)} ${streak}</div>
            <div class="roster-status status-${student.status}">${student.status}</div>
        </div>
        <div class="attendance-actions">
            <button data-status="PRESENT" class="mark-btn present-btn ${student.status === "PRESENT" ? "is-current" : ""}">Present</button>
            <button data-status="LATE" class="mark-btn late-btn ${student.status === "LATE" ? "is-current" : ""}">Late</button>
            <button data-status="ABSENT" class="mark-btn absent-btn ${student.status === "ABSENT" ? "is-current" : ""}">Absent</button>
        </div>`;
    wireMarkButtons(row, student);
    return row;
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

    wireMarkButtons(card, student);

    return card;
}

async function undoMark(studentId, previousStatus, classId) {
    try {
        if (previousStatus === "UNMARKED") {
            await apiPost("/api/attendance/clear", { studentId, classId, date: currentDate });
        } else {
            await apiPost("/api/attendance", { studentId, classId, status: previousStatus, date: currentDate });
        }
        toast("Reverted.");
        await loadStudents(currentDate, true);
    } catch (err) {
        toast(err.message, "error");
    }
}

// Nobody uploads real photos in this demo app, so give every student a
// stable, distinct-looking initials avatar instead of a blank/empty card.
// Seeded on their email so the same student always gets the same avatar.
function avatarUrl(student) {
    const seed = encodeURIComponent(student.email || student.name || String(student.id));
    return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&backgroundType=gradientLinear`;
}
