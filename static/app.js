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
    if (nameEl) {
        const roleBit = user.className ? `${user.role} \u00B7 ${user.className}` : user.role;
        nameEl.textContent = `${user.name} \u00B7 ${roleBit}`;
    }

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
// stacks at the bottom of the screen, auto-dismisses. Pass actionLabel +
// onAction to add a button (e.g. "Undo") inside the toast itself.
function toast(message, kind, actionLabel, onAction) {
    let host = document.querySelector(".toast-host");
    if (!host) {
        host = document.createElement("div");
        host.className = "toast-host";
        document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast ${kind === "error" ? "toast-error" : "toast-ok"}`;

    const textEl = document.createElement("span");
    textEl.textContent = message;
    el.appendChild(textEl);

    let dismissTimer;
    const dismiss = () => {
        clearTimeout(dismissTimer);
        el.classList.remove("toast-show");
        setTimeout(() => el.remove(), 250);
    };

    if (actionLabel && onAction) {
        const btn = document.createElement("button");
        btn.className = "toast-action";
        btn.textContent = actionLabel;
        btn.addEventListener("click", () => {
            onAction();
            dismiss();
        });
        el.appendChild(btn);
    }

    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-show"));
    dismissTimer = setTimeout(dismiss, actionLabel ? 5000 : 2800);
}

// Simple debounce for search/filter inputs so typing on mobile stays smooth.
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// Turns an ISO date ("2026-09-15") from the API into something readable,
// e.g. "Tue, Sep 15, 2026".
function formatDisplayDate(isoDate) {
    if (!isoDate) return "";
    const d = new Date(`${isoDate}T00:00:00`);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

// Fills the small date pill shown next to a page's "Today" heading.
function setDatePill(isoDate) {
    const el = document.getElementById("today-date");
    if (el) el.textContent = formatDisplayDate(isoDate);
}

// Renders a handful of shimmering placeholder blocks while data loads,
// instead of a plain "Loading..." line.
function skeletonBlocks(count, className) {
    const wrap = document.createElement("div");
    wrap.className = "skeleton-wrap";
    for (let i = 0; i < count; i++) {
        const block = document.createElement("div");
        block.className = `skeleton ${className || ""}`;
        wrap.appendChild(block);
    }
    return wrap;
}

// Triggers a browser download of a CSV file built from an array of rows
// (each row an array of cell values). Handles basic quoting/escaping.
function downloadCsv(filename, rows) {
    const csv = rows
        .map((row) =>
            row
                .map((cell) => {
                    const value = cell === null || cell === undefined ? "" : String(cell);
                    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
                })
                .join(",")
        )
        .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

// Registers the service worker so the app can be installed to a phone's
// home screen. Safe to call on every page; browsers that don't support it
// simply skip the block.
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("static/sw.js").catch(() => {
            /* offline install just won't be available - the app still works normally */
        });
    });
}
