document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("student");
    if (!user) return;
    wireTopbar(user);
    await loadHistory();
});

async function loadHistory() {
    const summaryEl = document.querySelector(".today-summary");
    const historyEl = document.querySelector(".attendance-history");
    let data;
    try {
        data = await apiGet("/api/attendance/me");
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    summaryEl.innerHTML = `
        <div class="stat-card stat-${data.todayStatus.toLowerCase()}">
            <div class="stat-value status-symbol status-${data.todayStatus}">${statusSymbol(data.todayStatus)}</div>
            <div class="stat-label">You're ${data.todayStatus.toLowerCase()} today</div>
        </div>
    `;

    if (data.records.length === 0) {
        historyEl.innerHTML = '<div class="empty-state">No attendance recorded yet.</div>';
        return;
    }

    historyEl.innerHTML = data.records
        .map(
            (r) => `
        <div class="history-row">
            <div class="history-date">${r.att_date}</div>
            <div class="history-status status-${r.status}">${r.status}</div>
        </div>`
        )
        .join("");
}

function statusSymbol(status) {
    if (status === "PRESENT") return "\u2713";
    if (status === "LATE") return "\u23F1";
    if (status === "ABSENT") return "\u2715";
    return "?";
}
