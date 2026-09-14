let allUsers = [];

document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardPage("admin");
    if (!user) return;
    wireTopbar(user);
    await loadOverview();
    await loadUsers();

    const search = document.getElementById("user-search");
    search.addEventListener(
        "input",
        debounce(() => renderUsers(filterUsers(search.value)), 150)
    );

    const createForm = document.getElementById("create-user-form");
    createForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("new-name").value.trim();
        const email = document.getElementById("new-email").value.trim();
        const password = document.getElementById("new-password").value;
        const role = document.getElementById("new-role").value;
        try {
            await apiPost("/api/users/create", { name, email, password, role });
            createForm.reset();
            toast(`${name} added as ${role}.`);
            await loadUsers();
            await loadOverview();
        } catch (err) {
            showFormError(createForm, err.message);
        }
    });
});

async function loadOverview() {
    const el = document.querySelector(".overview-stats");
    try {
        const data = await apiGet("/api/overview");
        const counts = data.userCounts;
        const today = data.todayAttendance;
        el.innerHTML = `
            <div class="stat-card"><div class="stat-value">${counts.student || 0}</div><div class="stat-label">Students</div></div>
            <div class="stat-card"><div class="stat-value">${counts.teacher || 0}</div><div class="stat-label">Teachers</div></div>
            <div class="stat-card"><div class="stat-value">${counts.admin || 0}</div><div class="stat-label">Admins</div></div>
            <div class="stat-card stat-present"><div class="stat-value">${today.PRESENT || 0}</div><div class="stat-label">Present today</div></div>
            <div class="stat-card stat-late"><div class="stat-value">${today.LATE || 0}</div><div class="stat-label">Late today</div></div>
            <div class="stat-card stat-absent"><div class="stat-value">${today.ABSENT || 0}</div><div class="stat-label">Absent today</div></div>
        `;
    } catch (err) {
        toast(err.message, "error");
    }
}

async function loadUsers() {
    const search = document.getElementById("user-search");
    try {
        const data = await apiGet("/api/users");
        allUsers = data.users;
    } catch (err) {
        toast(err.message, "error");
        return;
    }
    renderUsers(filterUsers(search ? search.value : ""));
}

function filterUsers(term) {
    const t = (term || "").trim().toLowerCase();
    if (!t) return allUsers;
    return allUsers.filter(
        (u) => u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t) || u.role.includes(t)
    );
}

function renderUsers(users) {
    const tbody = document.querySelector("#users-table tbody");
    tbody.innerHTML = "";

    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No matching accounts.</td></tr>';
        return;
    }

    for (const u of users) {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td data-label="Name">${escapeHtml(u.name)}</td>
            <td data-label="Email">${escapeHtml(u.email)}</td>
            <td data-label="Role"><span class="role-badge role-${u.role}">${u.role}</span></td>
            <td data-label=""><button class="delete-btn" data-id="${u.id}">Delete</button></td>
        `;
        row.querySelector(".delete-btn").addEventListener("click", async () => {
            if (!confirm(`Remove ${u.name}?`)) return;
            try {
                await apiPost("/api/users/delete", { id: u.id });
                toast(`${u.name} removed.`);
                await loadUsers();
                await loadOverview();
            } catch (err) {
                toast(err.message, "error");
            }
        });
        tbody.appendChild(row);
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
