let allUsers = [];
let allClasses = [];
let currentUserId = null;
let editingUserId = null;
let roleFilter = "all";
let unassignedOnly = false;
let pendingOnly = false;   // show only students waiting for class approval

document.addEventListener("DOMContentLoaded", async () => {
    const me = await guardPage("admin");
    if (!me) return;
    currentUserId = me.id;
    wireTopbar(me);
    addPasswordEye(document.getElementById("new-password"));

    setDatePill(new Date().toISOString().slice(0, 10));

    await Promise.all([loadOverview(), loadTrends(), loadClasses()]);
    await loadUsers();

    document.getElementById("user-search").addEventListener(
        "input",
        debounce(() => renderUsers(filteredUsers()), 150)
    );

    document.querySelectorAll("[data-role-filter]").forEach((btn) =>
        btn.addEventListener("click", () => {
            roleFilter = btn.dataset.roleFilter;
            unassignedOnly = false;
            pendingOnly = false;
            renderUsers(filteredUsers());
        })
    );

    document.getElementById("filter-notice-clear").addEventListener("click", () => {
        unassignedOnly = false;
        pendingOnly = false;
        renderUsers(filteredUsers());
    });

    document.getElementById("create-user-form").addEventListener("submit", handleCreateUser);
    document.getElementById("new-role").addEventListener("change", updateNewUserClassVisibility);
    updateNewUserClassVisibility();

    fillClassSelects(
        document.getElementById("new-class-year"),
        document.getElementById("new-class-course"),
        document.getElementById("new-class-course-other")
    );
    fillSetSelect(document.getElementById("new-class-set"));
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
            <button type="button" class="stat-card stat-link" data-go-role="student" title="See all students"><div class="stat-value">${u.student || 0}</div><div class="stat-label">Students</div></button>
            <button type="button" class="stat-card stat-link" data-go-role="teacher" title="See all teachers"><div class="stat-value">${u.teacher || 0}</div><div class="stat-label">Teachers</div></button>
            <button type="button" class="stat-card stat-link" data-go-role="admin" title="See all admins"><div class="stat-value">${u.admin || 0}</div><div class="stat-label">Admins</div></button>
            <div class="stat-card stat-present"><div class="stat-value">${t.PRESENT || 0}</div><div class="stat-label">Present today</div></div>
            <div class="stat-card stat-late"><div class="stat-value">${t.LATE || 0}</div><div class="stat-label">Late today</div></div>
            <div class="stat-card stat-absent"><div class="stat-value">${t.ABSENT || 0}</div><div class="stat-label">Absent today</div></div>
        `;
        el.querySelectorAll("[data-go-role]").forEach((card) =>
            card.addEventListener("click", () => {
                roleFilter = card.dataset.goRole;
                unassignedOnly = false;
                pendingOnly = false;
                document.getElementById("user-search").value = "";
                renderUsers(filteredUsers());
                goToView("accounts");
            })
        );
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
// Overview: things that need an admin's attention
// ---------------------------------------------------------------------------

function goToView(view) {
    history.replaceState(null, "", `#${view}`);
    showNavView(view);
}

function renderAttention() {
    const panel = document.getElementById("attention-panel");
    const list = document.getElementById("attention-list");
    if (!panel || !list) return;

    const items = [];
    const waiting = allUsers.filter((u) => u.role === "student" && u.request).length;
    if (waiting) {
        items.push({
            text: `${waiting} student${waiting === 1 ? " is" : "s are"} waiting for class approval`,
            action: "Review",
            run: () => {
                roleFilter = "student";
                unassignedOnly = false;
                pendingOnly = true;
                renderUsers(filteredUsers());
                goToView("accounts");
            },
        });
    }
    const noClass = allUsers.filter((u) => u.role === "student" && !u.request && !(u.classes || []).length).length;
    if (noClass) {
        items.push({
            text: `${noClass} student${noClass === 1 ? " has" : "s have"} no class yet`,
            action: "Assign",
            run: () => {
                roleFilter = "student";
                unassignedOnly = true;
                pendingOnly = false;
                renderUsers(filteredUsers());
                goToView("accounts");
            },
        });
    }
    const noTeacher = allClasses.filter((c) => !(c.teachers || []).length).length;
    if (noTeacher) {
        items.push({
            text: `${noTeacher} class${noTeacher === 1 ? " has" : "es have"} no teacher`,
            action: "Fix",
            run: () => goToView("classes"),
        });
    }
    const noStudents = allClasses.filter((c) => !c.studentCount).length;
    if (noStudents) {
        items.push({
            text: `${noStudents} class${noStudents === 1 ? " has" : "es have"} no students`,
            action: "View",
            run: () => goToView("classes"),
        });
    }

    panel.hidden = items.length === 0;
    list.innerHTML = items
        .map((it, i) => `<li><span>${it.text}</span><button type="button" class="btn btn-outline" data-attention="${i}">${it.action}</button></li>`)
        .join("");
    list.querySelectorAll("[data-attention]").forEach((btn) =>
        btn.addEventListener("click", () => items[Number(btn.dataset.attention)].run())
    );
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
        renderAttention();
    } catch (err) {
        toast(err.message, "error");
    }
}

function classLabel(c) {
    const bits = [c.name];
    const meta = [c.year_level, c.set_name, c.course].filter(Boolean).join(" \u00B7 ");
    if (meta) bits.push(`(${meta})`);
    return bits.join(" ");
}

function renderClassesList() {
    const el = document.getElementById("classes-list");
    const openClasses = new Set(
        [...el.querySelectorAll("details[open][data-class-details]")].map((d) => d.dataset.classDetails)
    );
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

            const classStudents = c.students || [];
            const inClass = new Set(classStudents.map((s) => s.id));
            const addableStudents = allUsers.filter((u) => u.role === "student" && !inClass.has(u.id));
            const studentChips = classStudents.length
                ? classStudents
                      .map((s) => `<span class="chip chip-student">${escapeHtml(s.name)}<button type="button" class="chip-remove" data-remove-student="${s.id}" data-class="${c.id}" title="Remove from class">&times;</button></span>`)
                      .join("")
                : '<span class="empty-inline">No students yet</span>';
            const addStudentControl = addableStudents.length
                ? `<div class="add-teacher-row">
                       <select class="custom-inp custom-select" data-add-student-select="${c.id}">
                           ${addableStudents.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("")}
                       </select>
                       <button type="button" class="btn btn-outline" data-add-student-btn="${c.id}">Add student</button>
                   </div>`
                : "";
            const noTeacherBadge = (c.teachers || []).length ? "" : '<span class="badge-warn">No teacher</span>';

            return `
            <div class="class-card">
                <div class="class-card-header">
                    <div class="class-card-title">${escapeHtml(c.name)} ${noTeacherBadge}</div>
                    <div class="class-card-actions">
                        <button type="button" class="btn btn-outline" data-edit-class="${c.id}">Edit</button>
                        <button type="button" class="btn btn-outline" data-delete-class="${c.id}">Delete</button>
                    </div>
                </div>
                <div class="class-card-meta">
                    ${c.year_level ? `<span>${escapeHtml(c.year_level)}</span>` : ""}
                    ${c.set_name ? `<span>${escapeHtml(c.set_name)}</span>` : ""}
                    ${c.course ? `<span>${escapeHtml(c.course)}</span>` : ""}
                    <span>${c.studentCount} student${c.studentCount === 1 ? "" : "s"}</span>
                </div>
                <div class="class-card-section-label">Teachers</div>
                <div class="class-card-teachers">${teacherChips}</div>
                ${addTeacherControl}
                <details class="class-card-details" data-class-details="${c.id}" ${openClasses.has(String(c.id)) ? "open" : ""}>
                    <summary class="class-card-section-label divider">Students (${classStudents.length})</summary>
                    <div class="class-card-students">${studentChips}</div>
                    ${addStudentControl}
                </details>
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
    el.querySelectorAll("[data-remove-student]").forEach((btn) => {
        btn.addEventListener("click", () => changeMembership("remove", btn.dataset.removeStudent, btn.dataset.class));
    });
    el.querySelectorAll("[data-add-student-btn]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const classId = btn.dataset.addStudentBtn;
            const select = el.querySelector(`[data-add-student-select="${classId}"]`);
            if (select && select.value) changeMembership("add", select.value, classId);
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
    const box = document.getElementById("new-class-checks");
    if (!box) return;
    const checked = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value));
    box.innerHTML = allClasses.length
        ? allClasses
              .map((c) => `<label class="class-check"><input type="checkbox" value="${c.id}" ${checked.has(String(c.id)) ? "checked" : ""}> ${escapeHtml(classLabel(c))}</label>`)
              .join("")
        : '<span class="empty-inline">No classes yet - add some in the Classes view.</span>';
}

// Add or remove one class for one person (student or teacher).
async function changeMembership(action, userId, classId) {
    try {
        await apiPost(`/api/users/classes/${action}`, { userId: Number(userId), classId: Number(classId) });
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function handleCreateClass(e) {
    e.preventDefault();
    const name = document.getElementById("new-class-name").value.trim();
    const yearLevel = document.getElementById("new-class-year").value;
    const course = readCourse(document.getElementById("new-class-course"), document.getElementById("new-class-course-other"));
    if (!name) return;
    try {
        await apiPost("/api/classes/create", { name, yearLevel, course, setName: document.getElementById("new-class-set").value });
        document.getElementById("create-class-form").reset();
        document.getElementById("new-class-course-other").hidden = true;
        toast(`Class "${name}" created.`);
        await loadClasses();
    } catch (err) {
        toast(err.message, "error");
    }
}

function editClass(classId) {
    const c = allClasses.find((x) => String(x.id) === String(classId));
    if (!c) return;
    const dlg = document.getElementById("class-dialog");
    const form = document.getElementById("class-edit-form");
    const err = document.getElementById("class-edit-error");
    const yearSel = document.getElementById("edit-class-year");
    const courseSel = document.getElementById("edit-class-course");
    const other = document.getElementById("edit-class-course-other");
    document.getElementById("edit-class-name").value = c.name;
    fillClassSelects(yearSel, courseSel, other, c.year_level || "", c.course || "");
    const setSel = document.getElementById("edit-class-set");
    fillSetSelect(setSel, c.set_name || "");
    err.hidden = true;

    form.onsubmit = async (e) => {
        e.preventDefault();
        const name = document.getElementById("edit-class-name").value.trim();
        if (!name) { err.textContent = "Please enter a class name."; err.hidden = false; return; }
        try {
            await apiPost("/api/classes/update", { id: classId, name, yearLevel: yearSel.value, course: readCourse(courseSel, other), setName: setSel.value });
            dlg.close();
            toast("Class updated.");
            await loadClasses();
        } catch (e2) {
            err.textContent = e2.message;
            err.hidden = false;
        }
    };
    document.getElementById("class-edit-cancel").onclick = () => dlg.close();
    dlg.showModal();
}

async function deleteClass(classId) {
    const c = allClasses.find((x) => String(x.id) === String(classId));
    if (!c) return;
    if (!confirm(`Delete "${c.name}"? Everyone is removed from it and its attendance records are deleted.`)) return;
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
    renderAttention();
}

function filteredUsers() {
    const term = (document.getElementById("user-search").value || "").trim().toLowerCase();
    return allUsers.filter((u) => {
        if (roleFilter !== "all" && u.role !== roleFilter) return false;
        if (unassignedOnly && (u.role !== "student" || u.request || (u.classes || []).length)) return false;
        if (pendingOnly && !(u.role === "student" && u.request)) return false;
        if (!term) return true;
        return u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term);
    });
}

function updateRoleFilterTabs() {
    const counts = { all: allUsers.length, student: 0, teacher: 0, admin: 0 };
    allUsers.forEach((u) => { if (counts[u.role] !== undefined) counts[u.role] += 1; });
    document.querySelectorAll("[data-role-filter]").forEach((btn) => {
        const key = btn.dataset.roleFilter;
        btn.classList.toggle("active", key === roleFilter);
        btn.setAttribute("aria-selected", key === roleFilter ? "true" : "false");
        const c = btn.querySelector(".filter-count");
        if (c) c.textContent = counts[key];
    });
    const notice = document.getElementById("filter-notice");
    if (notice) {
        notice.hidden = !(unassignedOnly || pendingOnly);
        document.getElementById("filter-notice-text").textContent = pendingOnly
            ? "Showing students waiting for class approval."
            : "Showing students with no class.";
    }
}

function renderUsers(users) {
    const tbody = document.querySelector("#users-table tbody");
    updateRoleFilterTabs();
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
    tbody.querySelectorAll("[data-role-select]").forEach((select) =>
        select.addEventListener("change", () => quickChangeRole(select.dataset.roleSelect, select.value))
    );
    tbody.querySelectorAll("[data-remove-membership]").forEach((btn) =>
        btn.addEventListener("click", () => changeMembership("remove", btn.dataset.removeMembership, btn.dataset.class))
    );
    tbody.querySelectorAll("[data-approve-request]").forEach((btn) => {
        const sel = document.getElementById(`approve-class-${btn.dataset.approveRequest}`);
        if (sel && btn.dataset.preselect) sel.value = btn.dataset.preselect;
        btn.addEventListener("click", () => approveRequest(btn.dataset.approveRequest));
    });
    tbody.querySelectorAll("[data-dismiss-request]").forEach((btn) =>
        btn.addEventListener("click", () => dismissRequest(btn.dataset.dismissRequest))
    );
    tbody.querySelectorAll("[data-add-membership]").forEach((select) =>
        select.addEventListener("change", () => {
            if (select.value) changeMembership("add", select.dataset.addMembership, select.value);
        })
    );
}

// Chips for every class a student/teacher is in, each removable, plus a
// "+ Add class" dropdown listing only the classes they aren't in yet.
function membershipCell(u, editable) {
    if (u.role !== "student" && u.role !== "teacher") return "&mdash;";
    const mine = u.classes || [];
    const pending = !!(editable && u.role === "student" && u.request);
    const chips = !mine.length && pending
        ? ""
        : mine.length
        ? mine.map((c) => `<span class="chip">${escapeHtml(c.name)}${editable
              ? `<button type="button" class="chip-remove" data-remove-membership="${u.id}" data-class="${c.id}" title="Remove from ${escapeHtml(c.name)}" aria-label="Remove from ${escapeHtml(c.name)}">&times;</button>`
              : ""}</span>`).join("")
        : `<span class="empty-inline">${u.role === "teacher" ? "No classes" : "No class yet"}</span>`;
    const have = new Set(mine.map((c) => c.id));
    const addable = allClasses.filter((c) => !have.has(c.id));
    const add = editable && addable.length && !pending
        ? `<select class="custom-inp custom-select add-class-select" data-add-membership="${u.id}" aria-label="Add a class for ${escapeHtml(u.name)}">
               <option value="">+ Add class</option>
               ${addable.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
           </select>`
        : "";
    const top = chips || add ? `<div class="membership-cell">${chips}${add}</div>` : "";
    return `${top}${editable ? requestBox(u) : ""}`;
}

// Classes that fit what the student asked for at sign-up: same year and course,
// with an exact set match listed first.
function suggestedClassesFor(req) {
    const norm = (v) => String(v || "").trim().toLowerCase();
    const fits = allClasses.filter(
        (c) => norm(c.year_level) === norm(req.yearLevel) && norm(c.course) === norm(req.course)
    );
    const exact = fits.filter((c) => req.setName && norm(c.set_name) === norm(req.setName));
    return { exact, others: fits.filter((c) => !exact.includes(c)) };
}

// "Waiting for approval" block for a student who asked for a class when signing up.
function requestBox(u) {
    if (u.role !== "student" || !u.request) return "";
    const r = u.request;
    const asked = [r.yearLevel, r.setName, r.course].filter(Boolean).join(" \u00B7 ");
    const { exact, others } = suggestedClassesFor(r);
    const suggested = [...exact, ...others];
    const have = new Set((u.classes || []).map((c) => c.id));
    const rest = allClasses.filter((c) => !suggested.includes(c) && !have.has(c.id));
    const opt = (c) => `<option value="${c.id}">${escapeHtml(classLabel(c))}</option>`;
    const preselect = exact.length ? exact[0].id : suggested.length === 1 ? suggested[0].id : "";
    const group = (label, list) => list.length ? `<optgroup label="${label}">${list.map(opt).join("")}</optgroup>` : "";
    const hint = suggested.length ? "" : '<div class="request-hint">No matching class yet.</div>';
    return `
        <div class="request-box">
            <span class="badge-warn request-badge">Waiting for approval</span>
            <div class="request-asked"><span class="request-label">Asked for</span>${escapeHtml(asked)}</div>
            ${hint}
            <div class="request-actions">
                <select class="custom-inp custom-select add-class-select" id="approve-class-${u.id}" aria-label="Class to add ${escapeHtml(u.name)} to">
                    <option value="">Choose a class...</option>
                    ${group("Matches their request", suggested)}
                    ${group("Other classes", rest)}
                </select>
                <button type="button" class="btn btn-solid request-btn" data-approve-request="${u.id}" data-preselect="${preselect}">Approve</button>
                <button type="button" class="btn btn-outline request-btn" data-dismiss-request="${u.id}">Dismiss</button>
            </div>
        </div>`;
}

async function approveRequest(studentId) {
    const sel = document.getElementById(`approve-class-${studentId}`);
    if (!sel || !sel.value) {
        toast("Choose which class to add them to first.", "error");
        return;
    }
    try {
        await apiPost("/api/class-requests/approve", { studentId: Number(studentId), classId: Number(sel.value) });
        toast("Approved. They're now in the class.");
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function dismissRequest(studentId) {
    try {
        await apiPost("/api/class-requests/dismiss", { studentId: Number(studentId) });
        toast("Request dismissed.");
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

function renderUserRow(u) {
    const isEditing = String(editingUserId) === String(u.id);

    if (isEditing) {
        const roleOptions = ["student", "teacher", "admin"]
            .map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`)
            .join("");
        return `
            <tr data-row-for="${u.id}">
                <td data-label="Name"><input class="custom-inp table-edit-inp" type="text" id="edit-name-${u.id}" value="${escapeHtml(u.name)}"></td>
                <td data-label="Email"><input class="custom-inp table-edit-inp" type="text" id="edit-email-${u.id}" value="${escapeHtml(u.email)}"></td>
                <td data-label="Role"><select class="custom-inp custom-select table-edit-inp" id="edit-role-${u.id}">${roleOptions}</select></td>
                <td data-label="Classes">${membershipCell(u, false)}</td>
                <td data-label="" class="row-actions">
                    <button type="button" class="row-icon-btn row-icon-save" data-save-edit="${u.id}" title="Save changes" aria-label="Save changes">Save</button>
                    <button type="button" class="row-icon-btn row-icon-cancel" data-cancel-edit="${u.id}" title="Cancel" aria-label="Cancel">Cancel</button>
                </td>
            </tr>`;
    }

    const classCell = membershipCell(u, true);

    const isSelf = String(u.id) === String(currentUserId);
    const roleCell = isSelf
        ? `<span class="role-tag role-${u.role}">${u.role} (you)</span>`
        : `<select class="custom-inp custom-select role-select role-${u.role}" data-role-select="${u.id}" aria-label="Role for ${escapeHtml(u.name)}">
               ${["student", "teacher", "admin"].map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}
           </select>`;
    const newBadge = u.isNew ? '<span class="badge-new" title="Joined in the last 7 days">New</span>' : "";
    return `
        <tr class="${u.isNew ? "row-new" : ""}">
            <td data-label="Name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}${newBadge}</td>
            <td data-label="Email" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
            <td data-label="Role">${roleCell}</td>
            <td data-label="Classes">${classCell}</td>
            <td data-label="" class="row-actions">
                <button type="button" class="row-icon-btn row-icon-edit" data-edit-user="${u.id}" title="Edit name, email or role" aria-label="Edit account">Edit</button>
                <button type="button" class="row-icon-btn row-icon-reset" data-reset-password="${u.id}" title="Set a new password for this person" aria-label="Reset password">Reset password</button>
                ${isSelf ? "" : `<button type="button" class="row-icon-btn row-icon-delete" data-delete-user="${u.id}" title="Delete this account" aria-label="Delete account">Delete</button>`}
            </td>
        </tr>`;
}

async function saveUserEdit(userId) {
    const name = document.getElementById(`edit-name-${userId}`).value.trim();
    const email = document.getElementById(`edit-email-${userId}`).value.trim();
    const role = document.getElementById(`edit-role-${userId}`).value;
    try {
        await apiPost("/api/users/update", { id: Number(userId), name, email, role });
        toast("Account updated.");
        editingUserId = null;
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function quickChangeRole(userId, newRole) {
    const u = allUsers.find((x) => String(x.id) === String(userId));
    if (!u || u.role === newRole) return;
    if (newRole === "admin" && !confirm(`Make ${u.name} an admin? They will be able to manage every account.`)) {
        renderUsers(filteredUsers());
        return;
    }
    // Switching student <-> teacher clears their classes (they mean different things).
    try {
        await apiPost("/api/users/update", { id: Number(userId), name: u.name, email: u.email, role: newRole });
        toast(`${u.name} is now a ${newRole}.`);
        await Promise.all([loadUsers(), loadClasses()]);
    } catch (err) {
        toast(err.message, "error");
        renderUsers(filteredUsers());
    }
}

function resetPassword(userId) {
    const u = allUsers.find((x) => String(x.id) === String(userId));
    let dlg = document.getElementById("reset-password-dialog");
    if (!dlg) {
        dlg = document.createElement("dialog");
        dlg.id = "reset-password-dialog";
        dlg.className = "password-dialog";
        dlg.innerHTML = `
            <form method="dialog" id="reset-password-form" novalidate>
                <h2 class="dialog-title">Reset password</h2>
                <div class="empty-state" id="reset-password-who" style="margin:0 0 4px; text-align:left;"></div>
                <label class="custom-label" for="reset-password-input">New password</label>
                <input class="custom-inp" type="password" id="reset-password-input" autocomplete="new-password" minlength="4" required>
                <div class="form-error" id="reset-password-error" role="alert" hidden></div>
                <div class="dialog-actions">
                    <button type="button" class="btn btn-outline" id="reset-password-cancel">Cancel</button>
                    <button type="submit" class="btn btn-solid" id="reset-password-save">Reset password</button>
                </div>
            </form>`;
        document.body.appendChild(dlg);
        addPasswordEye(dlg.querySelector("#reset-password-input"));

        const form = dlg.querySelector("#reset-password-form");
        const errorEl = dlg.querySelector("#reset-password-error");
        dlg.querySelector("#reset-password-cancel").addEventListener("click", () => dlg.close());
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            errorEl.hidden = true;
            const newPassword = dlg.querySelector("#reset-password-input").value;
            if (newPassword.length < 4) {
                errorEl.textContent = "Password must be at least 4 characters.";
                errorEl.hidden = false;
                return;
            }
            const saveBtn = dlg.querySelector("#reset-password-save");
            saveBtn.disabled = true;
            try {
                await apiPost("/api/users/reset-password", { id: Number(dlg.dataset.userId), newPassword });
                dlg.close();
                toast("Password reset.");
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.hidden = false;
            } finally {
                saveBtn.disabled = false;
            }
        });
    }
    dlg.dataset.userId = userId;
    dlg.querySelector("#reset-password-who").textContent = u ? `For ${u.name}` : "";
    dlg.querySelector("#reset-password-form").reset();
    dlg.querySelector("#reset-password-error").hidden = true;
    dlg.showModal();
    dlg.querySelector("#reset-password-input").focus();
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
    document.getElementById("new-user-class-group").style.display =
        role === "student" || role === "teacher" ? "block" : "none";
}

async function handleCreateUser(e) {
    e.preventDefault();
    const form = e.target;
    const name = document.getElementById("new-name").value.trim();
    const email = document.getElementById("new-email").value.trim();
    const password = document.getElementById("new-password").value;
    const role = document.getElementById("new-role").value;
    const classIds = [...document.querySelectorAll("#new-class-checks input:checked")].map((i) => Number(i.value));
    try {
        await apiPost("/api/users/create", { name, email, password, role, classIds });
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

