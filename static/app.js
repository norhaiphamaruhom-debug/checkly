// Shared helpers used across all Checkly pages.

async function apiGet(path) {
    const res = await fetch(path, { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

async function apiPost(path, body) {
    const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

// Confirms the visitor is logged in and (optionally) has the right role.
// Redirects to the login page or that role's dashboard otherwise.
async function guardPage(requiredRole) {
    let session;
    try {
        session = await apiGet("/api/session");
    } catch (e) {
        window.location.href = "index.html";
        return null;
    }
    if (!session.user) {
        window.location.href = "index.html";
        return null;
    }
    if (requiredRole && session.user.role !== requiredRole) {
        window.location.href = roleHome(session.user.role);
        return null;
    }
    return session.user;
}

function roleHome(role) {
    if (role === "admin") return "admin.html";
    if (role === "teacher") return "teacher.html";
    return "student.html";
}

function wireTopbar(user) {
    const nameEl = document.querySelector(".account-name");
    if (nameEl) nameEl.textContent = `${user.name} \u00B7 ${user.role}`;

    const logoutBtn = document.querySelector(".logout-button");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            try {
                await apiPost("/api/logout");
            } finally {
                window.location.href = "index.html";
            }
        });
    }
}

function showFormError(formEl, message) {
    let errorEl = formEl.querySelector(".form-error");
    if (!errorEl) {
        errorEl = document.createElement("div");
        errorEl.className = "form-error";
        formEl.appendChild(errorEl);
    }
    errorEl.textContent = message;
}

// Lightweight, mobile-friendly toast instead of alert() - non-blocking,
// stacks at the bottom of the screen, auto-dismisses.
function toast(message, kind) {
    let host = document.querySelector(".toast-host");
    if (!host) {
        host = document.createElement("div");
        host.className = "toast-host";
        document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast ${kind === "error" ? "toast-error" : "toast-ok"}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-show"));
    setTimeout(() => {
        el.classList.remove("toast-show");
        setTimeout(() => el.remove(), 250);
    }, 2800);
}

// Simple debounce for search/filter inputs so typing on mobile stays smooth.
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}
