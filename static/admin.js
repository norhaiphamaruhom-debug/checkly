let allUsers = [];
let allClasses = [];
let currentUserId = null;
let editingUserId = null;

document.addEventListener("DOMContentLoaded", async () => {
    const me = await guardPage("admin");
    if (!me) return;
    currentUserId = me.id;
    wireTopbar(me);

    setDatePill(new Date().toISOString().slice(0, 10));

    await Promise.all([loadOverview(), loadTrends(), loadClasses()]);
    await loadUsers();

    document.getElementById("user-search").addEventListener(
        "input",
        debounce(() => renderUsers(filteredUsers()), 150)
    );

    document.getElementById("create-user-form").addEventListener("submit", handleCreateUser);
    document.getElementById("new-role").addEventListener("change", updateNewUserClassVisibility);
    updateNewUserClassVisibility();

    document.getElementById("create-class-form").addEventListener("submit", handleCreateClass);
    document.getElementById("import-btn").addEventListener("click", handleImport);
});

// ---------------------------------------------------------------------------
// Overview + trends
// ---------------------------------------------------------------------------

async function loadOverview() {
    const el = document.querySelector(".overview-stats");
    try {
        const data = await apiGet("/api/overview");
        const u = data.userCounts || {};
        const t = data.todayAttendance || {};
        el.innerHTML = `
            <div class="stat-card"><div class="stat-value">${u.student || 0}</div><div class="stat-label">Students</div></div>
            <div class="stat-card"><div class="stat-value">${u.teacher || 0}</div><div class="stat-label">Teachers</div></div>
            <div class="stat-card"><div class="stat-value">${u.admin || 0}</div><div class="stat-label">Admins</div></div>
            <div class="stat-card stat-present"><div class="stat-value">${t.PRESENT || 0}</div><div class="stat-label">Present today</div></div>
            <div class="stat-card stat-late"><div class="stat-value">${t.LATE || 0}</div><div class="stat-label">Late today</div></div>
            <div class="stat-card stat-absent"><div class="stat-value">${t.ABSENT || 0}</div><div class="stat-label">Absent today</div></div>
        `;
    } catch (err) {
        toast(err.message, "error");
    }
}

async function loadTrends() {
    try {
        const data = await apiGet("/api/trends");
        drawTrendsChart(data.days || []);
    } catch (err) {
        toast(err.message, "error");
    }
}

function drawTrendsChart(days) {
    const svg = document.getElementById("trends-chart");
    if (!days.length) {
        svg.innerHTML = "";
        return;
    }
    const width = 700, height = 200, pad = 24;
    const maxVal = Math.max(1, ...days.map((d) => d.present + d.late + d.absent));
    const stepX = (width - pad * 2) / Math.max(1, days.length - 1);

    function pointsFor(key) {
        return days
            .map((d, i) => {
                const x = pad + i * stepX;
                const y = height - pad - (d[key] / maxVal) * (height - pad * 2);
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
    }

    const lines = [
        { key: "present", color: "#2f8a4a" },
        { key: "late", color: "#c98a1c" },
        { key: "absent", color: "#c0392b" },
    ];

    svg.innerHTML = `
        <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="currentColor" stroke-opacity="0.15" />
        ${lines
            .map(
                (l) => `<polyline points="${pointsFor(l.key)}" fill="none" stroke="${l.color}" stroke-width="2" />`
            )
            .join("")}
    `;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

async function loadClasses() {
    try {
        const data = await apiGet("/api/classes");
        allClasses = data.classes || [];
        renderClassesList();
        populateClassSelects();
    } catch (err) {
        toast(err.message, "error");
    }
}

function classLabel(c) {
    const bits = [c.name];
    const meta = [c.year_level, c.course].filter(Boolean).join(" \u00B7 ");
    if (meta) bits.push(`(${meta})`);
    return bits.join(" ");
}

function renderClassesList() {
    const el = document.getElementById("classes-list");
    if (allClasses.length === 0) {
        el.innerHTML = '<div class="empty-state">No classes yet. Add one above.</div>';
        return;
    }

    const teachers = allUsers.filter((u) => u.role === "teacher");

    el.innerHTML = allClasses
        .map((c) => {
            const assignedIds = new Set((c.teachers || []).map((t) => t.id));
            const available = teachers.filter((t) => !assignedIds.has(t.id));
            const teacherChips = (c.teachers || [])
                .map(
                    (t) => `
                <span class="chip">
                    ${escapeHtml(t.name)}
                    <button type="button" class="chip-remove" data-remove-teacher="${t.id}" data-class="${c.id}" title="Remove">&times;</button>
                </span>`
                )
                .join("") || '<span class="empty-inline">No teacher assigned</span>';

            const addTeacherControl = available.length
                ? `
                <div class="add-teacher-row">
                    <select class="custom-inp custom-select" data-add-teacher-select="${c.id}">
                        ${available.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}
                    </select>
                    <button type="button" class="btn btn-outline" data-add-teacher-btn="${c.id}">Add teacher</button>
                </div>`
                : "";

            const classStudents = allUsers.filter((u) => u.role === "student" && u.class_id === c.id);
            const studentChips = classStudents.length
                ? classStudents
                      .map((s) => `<span class="chip chip-student">${escapeHtml(s.name)}</span>`)
                      .join("")
                : '<span class="empty-inline">No students yet</span>';

            return `
            <div class="class-card">
                <div class="class-card-header">
                    <div class="class-card-title">${escapeHtml(c.name)}</div>
                    <div class="class-card-actions">
                        <button type="button" class="btn btn-outline" data-edit-class="${c.id}">Edit</button>
                        <button type="button" class="btn btn-outline" data-delete-class="${c.id}">Delete</button>
                    </div>
                </div>
                <div class="class-card-meta">
                    ${c.year_level ? `<span>${escapeHtml(c.year_level)}</span>` : ""}
                    ${c.course ? `<span>${escapeHtml(c.course)}</span>` : ""}
                    <span>${c.studentCount} student${c.studentCount === 1 ? "" : "s"}</span>
                </div>
                <div class="class-card-section-label">Teachers</div>
                <div class="class-card-teachers">${teacherChips}</div>
                ${addTeacherControl}
                <div class="class-card-section-label divider">Students (${classStudents.length})</div>
                <div class="class-card-students">${studentChips}</div>
            </div>`;
        })
        .join("");

    el.querySelectorAll("[data-remove-teacher]").forEach((btn) => {
        btn.addEventListener("click", () =>
            removeTeacherFromClass(btn.dataset.class, btn.dataset.removeTeacher)
        );
    });
    el.querySelectorAll("[data-add-teacher-btn]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const classId = btn.dataset.addTeacherBtn;
            const select = el.querySelector(`[data-add-teacher-select="${classId}"]`);
            if (select && select.value) addTeacherToClass(classId, select.value);
        });
    });
    el.querySelectorAll("[data-edit-class]").forEach((btn) => {
        btn.addEventListener("click", () => editClass(btn.dataset.editClass));
    });
    el.querySelectorAll("[data-delete-class]").forEach((btn) => {
        btn.addEventListener("click", () => deleteClass(btn.dataset.deleteClass));
    });
}

function populateClassSelects() {
    const options = ['<option value="">Unassigned</option>']
        .concat(allClasses.map((c) => `<option value="${c.id}">${escapeHtml(classLabel(c))}</option>`))
        .join("");
    const newClassSelect = document.getElementById("new-class");
    if (newClassSelect) newClassSelect.innerHTML = options;
}

async function handleCreateClass(e) {
    e.preventDefault();
    const name = document.getElementById("new-class-name").value.trim();
    const yearLevel = document.getElementById("new-class-year").value.trim();
    const course = document.getElementById("new-class-course").value.trim();
    if (!name) return;
    try {
        await apiPost("/api/classes/create", { name, yearLevel, course });
        document.getElementById("create-class-form").reset();
        toast(`Class "${name}" created.`);
        await loadClasses();
    } catch (err) {
        toast(err.message, "error");
    }
}

async function editClass(classId) {
    const c = allClasses.find((x) => String(x.id) === String(classId));
    if (!c) return;
    const name = prompt("Class name", c.name);
    if (name === null) return;
    const yearLevel = prompt("Year level (optional)", c.year_level || "");
    if (yearLevel === null) return;
    const course = prompt("Course/subject (optional)", c.course || "");
    if (course === null) return;
    try {
        await apiPost("/api/classes/update", { id: classId, name: name.trim(), yearLevel: yearLevel.trim(), course: course.trim() });
        toast("Class updated.");
        await loadClasses();
    } catch (err) {
        toast(err.message, "error");
    }
}

async function deleteClass(classId) {
    const c = allClasses.find((x) => String(x.id) === String(classId));
    if (!c) return;
    if (!confirm(`Delete "${c.name}"? Students in this class will become unassigned.`)) return;
    try {
        await apiPost("/api/classes/delete", { id: classId });
        toast("Class deleted.");
        await Promise.all([loadClasses(), loadUsers()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function addTeacherToClass(classId, teacherId) {
    try {
        await apiPost("/api/classes/teachers/add", { classId, teacherId });
        await loadClasses();
    } catch (err) {
        toast(err.message, "error");
    }
}

async function removeTeacherFromClass(classId, teacherId) {
    try {
        await apiPost("/api/classes/teachers/remove", { classId, teacherId });
        await loadClasses();
    } catch (err) {
        toast(err.message, "error");
    }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function loadUsers() {
    const tbody = document.querySelector("#users-table tbody");
    tbody.innerHTML = "";
    try {
        const data = await apiGet("/api/users");
        allUsers = data.users || [];
    } catch (err) {
        toast(err.message, "error");
        return;
    }
    renderClassesList(); // teacher chips depend on allUsers too
    renderUsers(filteredUsers());
}

function filteredUsers() {
    const term = (document.getElementById("user-search").value || "").trim().toLowerCase();
    if (!term) return allUsers;
    return allUsers.filter(
        (u) => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)
    );
}

function renderUsers(users) {
    const tbody = document.querySelector("#users-table tbody");
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No accounts match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = users.map((u) => renderUserRow(u)).join("");

    tbody.querySelectorAll("[data-edit-user]").forEach((btn) =>
        btn.addEventListener("click", () => {
            editingUserId = btn.dataset.editUser;
            renderUsers(filteredUsers());
        })
    );
    tbody.querySelectorAll("[data-cancel-edit]").forEach((btn) =>
        btn.addEventListener("click", () => {
            editingUserId = null;
            renderUsers(filteredUsers());
        })
    );
    tbody.querySelectorAll("[data-save-edit]").forEach((btn) =>
        btn.addEventListener("click", () => saveUserEdit(btn.dataset.saveEdit))
    );
    tbody.querySelectorAll("[data-delete-user]").forEach((btn) =>
        btn.addEventListener("click", () => deleteUser(btn.dataset.deleteUser))
    );
    tbody.querySelectorAll("[data-reset-password]").forEach((btn) =>
        btn.addEventListener("click", () => resetPassword(btn.dataset.resetPassword))
    );
    tbody.querySelectorAll("[data-class-select]").forEach((select) =>
        select.addEventListener("change", () => quickAssignClass(select.dataset.classSelect, select.value))
    );
}

function renderUserRow(u) {
    const isEditing = String(editingUserId) === String(u.id);

    if (isEditing) {
        const roleOptions = ["student", "teacher", "admin"]
            .map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`)
            .join("");
        const classOptions = ['<option value="">Unassigned</option>']
            .concat(
                allClasses.map(
                    (c) => `<option value="${c.id}" ${c.id === u.class_id ? "selected" : ""}>${escapeHtml(classLabel(c))}</option>`
                )
            )
            .join("");
        return `
            <tr data-row-for="${u.id}">
                <td data-label="Name"><input class="custom-inp table-edit-inp" type="text" id="edit-name-${u.id}" value="${escapeHtml(u.name)}"></td>
                <td data-label="Email"><input class="custom-inp table-edit-inp" type="text" id="edit-email-${u.id}" value="${escapeHtml(u.email)}"></td>
                <td data-label="Role"><select class="custom-inp custom-select table-edit-inp" id="edit-role-${u.id}">${roleOptions}</select></td>
                <td data-label="Class"><select class="custom-inp custom-select table-edit-inp" id="edit-class-${u.id}">${classOptions}</select></td>
                <td data-label="" class="row-actions">
                    <button type="button" class="row-icon-btn row-icon-save" data-save-edit="${u.id}" title="Save changes" aria-label="Save changes">&#10003;</button>
                    <button type="button" class="row-icon-btn row-icon-cancel" data-cancel-edit="${u.id}" title="Cancel" aria-label="Cancel">&#10005;</button>
                </td>
            </tr>`;
    }

    let classCell;
    if (u.role === "student") {
        const options = ['<option value="">Unassigned</option>']
            .concat(
                allClasses.map(
                    (c) => `<option value="${c.id}" ${c.id === u.class_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`
                )
            )
            .join("");
        classCell = `<select class="custom-inp custom-select" data-class-select="${u.id}">${options}</select>`;
    } else if (u.role === "teacher") {
        classCell = u.classNames && u.classNames.length ? escapeHtml(u.classNames.join(", ")) : '<span class="empty-inline">No classes</span>';
    } else {
        classCell = "&mdash;";
    }

    const isSelf = String(u.id) === String(currentUserId);
    return `
        <tr>
            <td data-label="Name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</td>
            <td data-label="Email" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
            <td data-label="Role"><span class="role-tag role-${u.role}">${u.role}</span></td>
            <td data-label="Class">${classCell}</td>
            <td data-label="" class="row-actions">
                <button type="button" class="row-icon-btn row-icon-edit" data-edit-user="${u.id}" title="Edit account" aria-label="Edit account">&#9998;</button>
                <button type="button" class="row-icon-btn row-icon-reset" data-reset-password="${u.id}" title="Reset password" aria-label="Reset password">&#8635;</button>
                ${isSelf ? "" : `<button type="button" class="row-icon-btn row-icon-delete" data-delete-user="${u.id}" title="Delete account" aria-label="Delete account">&#10005;</button>`}
            </td>
        </tr>`;
}

async function saveUserEdit(userId) {
    const name = document.getElementById(`edit-name-${userId}`).value.trim();
    const email = document.getElementById(`edit-email-${userId}`).value.trim();
    const role = document.getElementById(`edit-role-${userId}`).value;
    const classSelect = document.getElementById(`edit-class-${userId}`);
    const classId = role === "student" && classSelect.value ? Number(classSelect.value) : null;
    try {
        await apiPost("/api/users/update", { id: Number(userId), name, email, role, classId });
        toast("Account updated.");
        editingUserId = null;
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function quickAssignClass(userId, classValue) {
    const u = allUsers.find((x) => String(x.id) === String(userId));
    if (!u) return;
    const classId = classValue ? Number(classValue) : null;
    try {
        await apiPost("/api/users/update", { id: Number(userId), name: u.name, email: u.email, role: u.role, classId });
        toast(`${u.name}'s class updated.`);
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function resetPassword(userId) {
    const newPassword = prompt("New password (4+ characters):");
    if (newPassword === null) return;
    if (newPassword.length < 4) {
        toast("Password must be at least 4 characters.", "error");
        return;
    }
    try {
        await apiPost("/api/users/reset-password", { id: Number(userId), newPassword });
        toast("Password reset.");
    } catch (err) {
        toast(err.message, "error");
    }
}

async function deleteUser(userId) {
    const u = allUsers.find((x) => String(x.id) === String(userId));
    if (!u) return;
    if (!confirm(`Delete ${u.name}'s account? This can't be undone.`)) return;
    try {
        await apiPost("/api/users/delete", { id: Number(userId) });
        toast("Account deleted.");
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

function updateNewUserClassVisibility() {
    const role = document.getElementById("new-role").value;
    document.getElementById("new-user-class-group").style.display = role === "student" ? "block" : "none";
}

async function handleCreateUser(e) {
    e.preventDefault();
    const form = e.target;
    const name = document.getElementById("new-name").value.trim();
    const email = document.getElementById("new-email").value.trim();
    const password = document.getElementById("new-password").value;
    const role = document.getElementById("new-role").value;
    const classSelect = document.getElementById("new-class");
    const classId = role === "student" && classSelect.value ? Number(classSelect.value) : null;
    try {
        await apiPost("/api/users/create", { name, email, password, role, classId });
        toast(`${name}'s account created.`);
        form.reset();
        updateNewUserClassVisibility();
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        showFormError(form, err.message);
    }
}

// ---------------------------------------------------------------------------
// CSV bulk import
// ---------------------------------------------------------------------------

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((line) => {
        const cells = line.split(",").map((c) => c.trim());
        const row = {};
        headers.forEach((h, i) => (row[h] = cells[i] || ""));
        return row;
    });
}

async function handleImport() {
    const fileInput = document.getElementById("import-file");
    const summaryEl = document.getElementById("import-summary");
    const errorsEl = document.getElementById("import-errors");
    summaryEl.textContent = "";
    errorsEl.innerHTML = "";

    const file = fileInput.files[0];
    if (!file) {
        toast("Choose a CSV file first.", "error");
        return;
    }

    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) {
        toast("That CSV looks empty.", "error");
        return;
    }

    try {
        const result = await apiPost("/api/users/bulk-create", { users: rows });
        summaryEl.textContent = `Created ${result.created} account${result.created === 1 ? "" : "s"}.`;
        if (result.errors && result.errors.length) {
            errorsEl.innerHTML = result.errors
                .map((e) => `<div class="import-error-row">${escapeHtml(e.row)}: ${escapeHtml(e.error)}</div>`)
                .join("");
        }
        fileInput.value = "";
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
}
