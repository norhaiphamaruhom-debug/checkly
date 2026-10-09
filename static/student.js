let allRecords = [];      // every record, all classes
let shownRecords = [];    // records after the class filter
let myClasses = [];
let classFilter = "all";  // "all" or a class id (as string)
let todayDate = null;
let calendarCursor = null; // {year, month} currently shown in the calendar view

document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("student");
    if (!user) return;
    wireTopbar(user);
    await loadHistory();

    document.getElementById("view-list-btn").addEventListener("click", () => setView("list"));
    document.getElementById("view-calendar-btn").addEventListener("click", () => setView("calendar"));
    document.getElementById("cal-prev").addEventListener("click", () => shiftCalendarMonth(-1));
    document.getElementById("cal-next").addEventListener("click", () => shiftCalendarMonth(1));
    document.getElementById("export-csv-btn").addEventListener("click", exportCsv);
    document.getElementById("history-class-filter").addEventListener("change", (e) => {
        classFilter = e.target.value;
        renderHistory();
    });
});

async function loadHistory() {
    const summaryEl = document.querySelector(".today-summary");
    const historyEl = document.querySelector(".attendance-history");
    historyEl.innerHTML = "";
    historyEl.appendChild(skeletonBlocks(4, "skeleton-row"));

    let data;
    try {
        data = await apiGet("/api/attendance/me");
    } catch (err) {
        historyEl.innerHTML = "";
        toast(err.message, "error");
        return;
    }

    allRecords = data.records;
    myClasses = data.classes || [];
    todayDate = data.date;

    renderClassBanner(myClasses, data.todayByClass || [], data.pendingRequest);
    setupClassFilter(data.classFilterOptions || []);
    renderHistory(data.todayStatus);

    const today = new Date(`${data.date}T00:00:00`);
    calendarCursor = { year: today.getFullYear(), month: today.getMonth() };
    renderCalendar();
}

// Only show the class filter when there's actually more than one class to choose from.
function setupClassFilter(options) {
    const sel = document.getElementById("history-class-filter");
    if (options.length <= 1) {
        sel.hidden = true;
        classFilter = "all";
        return;
    }
    sel.hidden = false;
    sel.innerHTML =
        '<option value="all">All classes</option>' +
        options.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
    sel.value = classFilter;
}

let lastTodayStatus = "UNMARKED";

function statusWord(st) {
    return { PRESENT: "Present", LATE: "Late", ABSENT: "Absent", UNMARKED: "Not marked yet" }[st] || st;
}
function statusSentence(st) {
    return { PRESENT: "You're present today", LATE: "You're marked late today", ABSENT: "You're marked absent today", UNMARKED: "Your teacher hasn't marked you yet today" }[st] || st;
}

// Stats, list and calendar all follow the class filter, so "Present overall"
// means "overall for the class you're looking at".
function renderHistory(todayStatus) {
    if (todayStatus) lastTodayStatus = todayStatus;
    shownRecords = classFilter === "all"
        ? allRecords
        : allRecords.filter((r) => String(r.classId) === String(classFilter));

    const counts = { PRESENT: 0, LATE: 0, ABSENT: 0 };
    shownRecords.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] += 1; });
    const percent = shownRecords.length ? Math.round((counts.PRESENT / shownRecords.length) * 100) : null;

    const summaryEl = document.querySelector(".today-summary");
    const historyEl = document.querySelector(".attendance-history");
    const status = lastTodayStatus;

    const percentCard = percent === null
        ? ""
        : `<div class="stat-card"><div class="stat-value">${percent}%</div><div class="stat-label">Present overall</div></div>`;
    const countCards = shownRecords.length
        ? `<div class="stat-card stat-present"><div class="stat-value">${counts.PRESENT}</div><div class="stat-label">Present</div></div>
           <div class="stat-card stat-late"><div class="stat-value">${counts.LATE}</div><div class="stat-label">Late</div></div>
           <div class="stat-card stat-absent"><div class="stat-value">${counts.ABSENT}</div><div class="stat-label">Absent</div></div>`
        : "";

    summaryEl.innerHTML = `
        <div class="stat-card stat-${status.toLowerCase()}">
            <div class="stat-value status-symbol status-${status}">${statusSymbol(status)}</div>
            <div class="stat-label">${statusSentence(status)}</div>
        </div>
        ${percentCard}
        ${countCards}
    `;
    setDatePill(todayDate);

    historyEl.innerHTML = shownRecords.length === 0
        ? '<div class="empty-state">No attendance recorded yet.</div>'
        : renderGroupedHistory(shownRecords);
    if (calendarCursor) renderCalendar();
}

function renderClassBanner(classes, todayByClass, pendingRequest) {
    const el = document.getElementById("class-banner");
    if (!el) return;
    el.hidden = false;
    if (!classes.length) {
        if (pendingRequest) {
            const asked = [pendingRequest.yearLevel, pendingRequest.setName, pendingRequest.course].filter(Boolean).join(" \u00B7 ");
            el.innerHTML = `<div class="class-banner-name">Waiting for approval</div><div class="class-banner-meta">You asked for ${escapeHtml(asked)}. An admin will confirm it soon.</div>`;
        } else {
            el.innerHTML = '<div class="class-banner-name">No classes yet</div><div class="class-banner-meta">An admin will add you to your classes.</div>';
        }
        return;
    }
    const todayMap = {};
    todayByClass.forEach((t) => { todayMap[t.classId] = t.status; });
    el.innerHTML = classes.map((c) => {
        const meta = [c.yearLevel, c.setName, c.course].filter(Boolean).join(" \u00B7 ");
        const teachers = c.teachers && c.teachers.length
            ? `Teacher${c.teachers.length === 1 ? "" : "s"}: ${c.teachers.join(", ")}`
            : "No teacher assigned yet";
        const st = todayMap[c.id] || "UNMARKED";
        return `
        <div class="class-banner-item">
            <div>
                <div class="class-banner-name">${escapeHtml(c.name)}</div>
                ${meta ? `<div class="class-banner-meta">${escapeHtml(meta)}</div>` : ""}
                <div class="class-banner-meta">${escapeHtml(teachers)}</div>
            </div>
            <div class="history-status status-${st}">${statusWord(st)}</div>
        </div>`;
    }).join("");
}

function renderGroupedHistory(records) {
    // records arrive newest first; group them under month headings.
    let currentKey = null;
    const out = [];
    for (const r of records) {
        const d = new Date(`${r.att_date}T00:00:00`);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        if (key !== currentKey) {
            currentKey = key;
            out.push(`<div class="history-month">${d.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>`);
        }
        const label = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
        const showClass = new Set(allRecords.map((x) => x.classId)).size > 1;
        out.push(`
            <div class="history-row">
                <div class="history-date" title="${r.att_date}">${label}${showClass ? ` <span class="history-class">${escapeHtml(r.className)}</span>` : ""}</div>
                <div class="history-status status-${r.status}">${r.status}</div>
            </div>`);
    }
    return out.join("");
}

function statusSymbol(status) {
    if (status === "PRESENT") return "\u2713";
    if (status === "LATE") return "\u23F1";
    if (status === "ABSENT") return "\u2715";
    return "?";
}

function setView(view) {
    const listView = document.getElementById("list-view");
    const calendarView = document.getElementById("calendar-view");
    const listBtn = document.getElementById("view-list-btn");
    const calBtn = document.getElementById("view-calendar-btn");

    listView.hidden = view !== "list";
    calendarView.hidden = view !== "calendar";
    listBtn.classList.toggle("active", view === "list");
    calBtn.classList.toggle("active", view === "calendar");
}

function shiftCalendarMonth(delta) {
    let { year, month } = calendarCursor;
    month += delta;
    if (month < 0) {
        month = 11;
        year -= 1;
    } else if (month > 11) {
        month = 0;
        year += 1;
    }
    calendarCursor = { year, month };
    renderCalendar();
}

function renderCalendar() {
    const { year, month } = calendarCursor;
    const label = document.getElementById("cal-month-label");
    label.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

    const weekdaysEl = document.getElementById("calendar-weekdays");
    weekdaysEl.innerHTML = ["S", "M", "T", "W", "T", "F", "S"]
        .map((d) => `<div class="calendar-weekday">${d}</div>`)
        .join("");

    const rank = { ABSENT: 3, LATE: 2, PRESENT: 1 };
    const byDate = {};
    for (const r of shownRecords) {
        if (!byDate[r.att_date] || rank[r.status] > rank[byDate[r.att_date]]) byDate[r.att_date] = r.status;
    }

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < firstDay; i++) {
        cells.push('<div class="calendar-cell cal-empty"></div>');
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const status = byDate[iso];
        const statusClass = status ? `cal-${status}` : "";
        cells.push(`<div class="calendar-cell ${statusClass}" title="${iso}${status ? ": " + status : ""}">${day}</div>`);
    }

    document.getElementById("calendar-grid").innerHTML = cells.join("");
}

function exportCsv() {
    if (shownRecords.length === 0) {
        toast("No attendance history to export yet.", "error");
        return;
    }
    const rows = [["Date", "Class", "Status"], ...shownRecords.map((r) => [r.att_date, r.className, r.status])];
    downloadCsv("attendance-history.csv", rows);
}
