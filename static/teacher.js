let allStudents = [];

document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("teacher");
    if (!user) return;
    wireTopbar(user);
    await loadStudents();

    const search = document.getElementById("student-search");
    search.addEventListener(
        "input",
        debounce(() => renderStudents(filterStudents(search.value)), 150)
    );
});

async function loadStudents() {
    const container = document.querySelector(".students-container");
    container.innerHTML = '<div class="empty-state">Loading students...</div>';
    try {
        const data = await apiGet("/api/students");
        allStudents = data.students;
    } catch (err) {
        container.innerHTML = "";
        toast(err.message, "error");
        return;
    }
    renderSummary(allStudents);
    const search = document.getElementById("student-search");
    renderStudents(filterStudents(search ? search.value : ""));
}

function filterStudents(term) {
    const t = (term || "").trim().toLowerCase();
    if (!t) return allStudents;
    return allStudents.filter(
        (s) => s.name.toLowerCase().includes(t) || s.email.toLowerCase().includes(t)
    );
}

function renderSummary(students) {
    const summaryEl = document.querySelector(".today-summary");
    const counts = { PRESENT: 0, LATE: 0, ABSENT: 0, UNMARKED: 0 };
    for (const s of students) counts[s.status] = (counts[s.status] || 0) + 1;

    summaryEl.innerHTML = `
        <div class="stat-card stat-present"><div class="stat-value">${counts.PRESENT}</div><div class="stat-label">Present today</div></div>
        <div class="stat-card stat-late"><div class="stat-value">${counts.LATE}</div><div class="stat-label">Late today</div></div>
        <div class="stat-card stat-absent"><div class="stat-value">${counts.ABSENT}</div><div class="stat-label">Absent today</div></div>
        <div class="stat-card stat-unmarked"><div class="stat-value">${counts.UNMARKED}</div><div class="stat-label">Unmarked</div></div>
    `;
}

function renderStudents(students) {
    const container = document.querySelector(".students-container");
    container.innerHTML = "";

    if (students.length === 0) {
        container.innerHTML = '<div class="empty-state">No students match your search.</div>';
        return;
    }

    for (const student of students) {
        container.appendChild(renderStudentCard(student));
    }
}

function renderStudentCard(student) {
    const card = document.createElement("div");
    card.className = "student-profiles";

    card.innerHTML = `
        <div class="student-profile-cover"></div>
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
            btn.disabled = true;
            try {
                await apiPost("/api/attendance", { studentId: student.id, status: btn.dataset.status });
                toast(`${student.name} marked ${btn.dataset.status.toLowerCase()}.`);
                await loadStudents();
            } catch (err) {
                toast(err.message, "error");
            } finally {
                btn.disabled = false;
            }
        });
    });

    return card;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
