let allRecords = [];
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

    const percentCard =
        data.percentPresent === null
            ? ""
            : `<div class="stat-card"><div class="stat-value">${data.percentPresent}%</div><div class="stat-label">Present this term</div></div>`;

    summaryEl.innerHTML = `
        <div class="stat-card stat-${data.todayStatus.toLowerCase()}">
            <div class="stat-value status-symbol status-${data.todayStatus}">${statusSymbol(data.todayStatus)}</div>
            <div class="stat-label">You're ${data.todayStatus.toLowerCase()} today</div>
        </div>
        ${percentCard}
    `;

    setDatePill(data.date);

    if (allRecords.length === 0) {
        historyEl.innerHTML = '<div class="empty-state">No attendance recorded yet.</div>';
    } else {
        historyEl.innerHTML = allRecords
            .map(
                (r) => `
            <div class="history-row">
                <div class="history-date">${r.att_date}</div>
                <div class="history-status status-${r.status}">${r.status}</div>
            </div>`
            )
            .join("");
    }

    const today = new Date(`${data.date}T00:00:00`);
    calendarCursor = { year: today.getFullYear(), month: today.getMonth() };
    renderCalendar();
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

    const byDate = {};
    for (const r of allRecords) byDate[r.att_date] = r.status;

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
    if (allRecords.length === 0) {
        toast("No attendance history to export yet.", "error");
        return;
    }
    const rows = [["Date", "Status"], ...allRecords.map((r) => [r.att_date, r.status])];
    downloadCsv("attendance-history.csv", rows);
}
