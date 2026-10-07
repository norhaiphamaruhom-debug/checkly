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

// Menu items per role. "view" items switch in-page sections (admin);
// "click" items trigger an existing button on the page by id.
const NAV_ITEMS = {
    admin: [
        { label: "Overview", view: "overview", icon: "&#9783;" },
        { label: "Classes", view: "classes", icon: "&#9871;" },
        { label: "People", view: "accounts", icon: "&#9786;" },
        { label: "Add people", short: "Add", view: "add", icon: "&#43;" },
    ],
    teacher: [
        { label: "Mark attendance", top: true },
        { label: "Mark all present", click: "mark-all-btn" },
        { label: "Print roster", click: "print-btn" },
    ],
    student: [
        { label: "Today", top: true },
        { label: "History (list)", click: "view-list-btn", scroll: "list-view" },
        { label: "History (calendar)", click: "view-calendar-btn", scroll: "calendar-view" },
        { label: "Export as CSV", click: "export-csv-btn" },
    ],
};

function showNavView(name) {
    const views = document.querySelectorAll(".nav-view");
    if (!views.length) return;
    let found = false;
    views.forEach((v) => { if (v.dataset.view === name) found = true; });
    if (!found) name = views[0].dataset.view;
    views.forEach((v) => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll(".nav-link[data-view], .tab-link[data-view]").forEach((a) => {
        const on = a.dataset.view === name;
        a.classList.toggle("active", on);
        if (a.classList.contains("tab-link")) a.setAttribute("aria-current", on ? "page" : "false");
    });
    const label = document.querySelector(`.tab-link[data-view="${name}"] .tab-label`);
    if (label) document.title = `${label.textContent.trim()} | Checkly`;
    window.scrollTo(0, 0);
}

function buildBurgerMenu(user) {
    const topbar = document.querySelector(".topbar");
    if (!topbar || topbar.querySelector(".burger-btn")) return;
    const items = NAV_ITEMS[user.role] || [];

    const burger = document.createElement("button");
    burger.type = "button";
    burger.className = "burger-btn";
    burger.setAttribute("aria-label", "Open menu");
    burger.setAttribute("aria-expanded", "false");
    burger.innerHTML = "<span></span><span></span><span></span>";
    topbar.insertBefore(burger, topbar.firstChild);

    const backdrop = document.createElement("div");
    backdrop.className = "nav-backdrop";
    const drawer = document.createElement("nav");
    drawer.className = "nav-drawer";
    drawer.setAttribute("aria-label", "Main menu");

    const head = document.createElement("div");
    head.className = "nav-drawer-head";
    head.textContent = "Checkly";
    drawer.appendChild(head);

    items.forEach((item) => {
        const a = document.createElement("a");
        a.href = item.view ? `#${item.view}` : "#";
        a.className = "nav-link";
        a.textContent = item.label;
        if (item.view) a.dataset.view = item.view;
        a.addEventListener("click", (e) => {
            e.preventDefault();
            close();
            if (item.view) {
                history.replaceState(null, "", `#${item.view}`);
                showNavView(item.view);
            } else if (item.top) {
                window.scrollTo({ top: 0, behavior: "smooth" });
            } else if (item.click) {
                const target = document.getElementById(item.click);
                if (target) target.click();
                if (item.scroll) {
                    const section = document.getElementById(item.scroll);
                    if (section) section.scrollIntoView({ behavior: "smooth" });
                }
            }
        });
        drawer.appendChild(a);
    });

    const pwLink = document.createElement("a");
    pwLink.href = "#";
    pwLink.className = "nav-link";
    pwLink.textContent = "Change password";
    pwLink.addEventListener("click", (e) => {
        e.preventDefault();
        close();
        openPasswordDialog();
    });
    drawer.appendChild(pwLink);

    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "nav-link nav-logout";
    logout.textContent = "Log out";
    logout.addEventListener("click", doLogout);
    drawer.appendChild(logout);

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    // Always-visible tabs for pages with several sections (admin), so people
    // never have to open the burger menu just to switch sections.
    const viewItems = items.filter((i) => i.view);
    const host = document.querySelector(".admin-container");
    if (viewItems.length > 1 && host) {
        const bar = document.createElement("nav");
        bar.className = "tab-bar";
        bar.setAttribute("aria-label", "Sections");
        viewItems.forEach((item) => {
            const t = document.createElement("a");
            t.href = `#${item.view}`;
            t.className = "tab-link";
            t.dataset.view = item.view;
            t.innerHTML = `<span class="tab-icon" aria-hidden="true">${item.icon || ""}</span><span class="tab-label">${item.short || item.label}</span>`;
            bar.appendChild(t);
        });
        host.insertBefore(bar, host.firstChild);
        document.body.classList.add("has-tab-bar");
    }

    function open() {
        document.body.classList.add("nav-open");
        burger.setAttribute("aria-expanded", "true");
    }
    function close() {
        document.body.classList.remove("nav-open");
        burger.setAttribute("aria-expanded", "false");
    }
    burger.addEventListener("click", () => {
        document.body.classList.contains("nav-open") ? close() : open();
    });
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    // Admin: show the section named in the URL hash (or the first one).
    if (document.querySelector(".nav-view")) {
        showNavView(location.hash.slice(1));
        window.addEventListener("hashchange", () => showNavView(location.hash.slice(1)));
    }
}

async function doLogout() {
    try {
        await apiPost("/api/logout");
    } finally {
        window.location.href = "index.html";
    }
}

function wireTopbar(user) {
    const nameEl = document.querySelector(".account-name");
    if (nameEl) {
        const names = user.classNames || [];
        const classBit = names.length > 2 ? `${names.length} classes` : names.join(", ");
        const roleBit = classBit ? `${user.role} \u00B7 ${classBit}` : user.role;
        nameEl.textContent = `${user.name} \u00B7 ${roleBit}`;
        if (names.length) nameEl.title = names.join(", ");
    }

    const logoutBtn = document.querySelector(".logout-button");
    if (logoutBtn) {
        logoutBtn.textContent = "Log out";
        logoutBtn.setAttribute("aria-label", "Log out");
        logoutBtn.addEventListener("click", doLogout);
    }

    buildBurgerMenu(user);

    if (user.defaultPassword) showDefaultPasswordBanner();
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
        navigator.serviceWorker.register("static/sw.js", { scope: "/" }).catch(() => {
            /* offline install just won't be available - the app still works normally */
        });
    });
}

// Shared HTML escaping, used by every page.
function escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}


// ---------------------------------------------------------------------------
// Change password (available from the menu on every page)
// ---------------------------------------------------------------------------

// The topbar is position:fixed, so the banner is fixed right beneath it and
// the page is nudged down by the banner's height so nothing is hidden.
function layoutDefaultPasswordBanner() {
    const banner = document.getElementById("default-pw-banner");
    const topbar = document.querySelector(".topbar");
    if (!banner || !topbar) return;
    banner.style.top = `${topbar.getBoundingClientRect().bottom}px`;
    document.body.style.paddingTop = `${banner.offsetHeight}px`;
}

function showDefaultPasswordBanner() {
    if (document.getElementById("default-pw-banner")) return;
    const banner = document.createElement("div");
    banner.id = "default-pw-banner";
    banner.className = "default-pw-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML =
        '<span>You\'re still using the default password. Please change it.</span>' +
        '<button type="button" class="btn btn-outline">Change password</button>';
    banner.querySelector("button").addEventListener("click", openPasswordDialog);
    document.body.appendChild(banner);
    layoutDefaultPasswordBanner();
    window.addEventListener("resize", layoutDefaultPasswordBanner);
}

function removeDefaultPasswordBanner() {
    const banner = document.getElementById("default-pw-banner");
    if (banner) banner.remove();
    document.body.style.paddingTop = "";
    window.removeEventListener("resize", layoutDefaultPasswordBanner);
}

function openPasswordDialog() {
    let dlg = document.getElementById("password-dialog");
    if (!dlg) {
        dlg = document.createElement("dialog");
        dlg.id = "password-dialog";
        dlg.className = "password-dialog";
        dlg.innerHTML = `
            <form method="dialog" id="password-form" novalidate>
                <h2 class="dialog-title">Change password</h2>
                <label class="custom-label" for="pw-current">Current password</label>
                <input class="custom-inp" type="password" id="pw-current" autocomplete="current-password" required>
                <label class="custom-label" for="pw-new">New password</label>
                <input class="custom-inp" type="password" id="pw-new" autocomplete="new-password" minlength="4" required>
                <label class="custom-label" for="pw-confirm">Confirm new password</label>
                <input class="custom-inp" type="password" id="pw-confirm" autocomplete="new-password" required>
                <div class="form-error" id="pw-error" role="alert" hidden></div>
                <div class="dialog-actions">
                    <button type="button" class="btn btn-outline" id="pw-cancel">Cancel</button>
                    <button type="submit" class="btn btn-solid" id="pw-save">Save</button>
                </div>
            </form>`;
        document.body.appendChild(dlg);

        const form = dlg.querySelector("#password-form");
        const errorEl = dlg.querySelector("#pw-error");
        const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };

        dlg.querySelector("#pw-cancel").addEventListener("click", () => dlg.close());
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            errorEl.hidden = true;
            const currentPassword = dlg.querySelector("#pw-current").value;
            const newPassword = dlg.querySelector("#pw-new").value;
            const confirmPassword = dlg.querySelector("#pw-confirm").value;
            if (!currentPassword || !newPassword) return fail("Please fill in every field.");
            if (newPassword.length < 4) return fail("New password must be at least 4 characters.");
            if (newPassword !== confirmPassword) return fail("The new passwords don't match.");

            const saveBtn = dlg.querySelector("#pw-save");
            saveBtn.disabled = true;
            try {
                await apiPost("/api/me/password", { currentPassword, newPassword });
                dlg.close();
                removeDefaultPasswordBanner();
                toast("Password changed. Other devices were signed out.");
            } catch (err) {
                fail(err.message);
            } finally {
                saveBtn.disabled = false;
            }
        });
    }
    dlg.querySelector("#password-form").reset();
    dlg.querySelector("#pw-error").hidden = true;
    dlg.showModal();
    dlg.querySelector("#pw-current").focus();
}
