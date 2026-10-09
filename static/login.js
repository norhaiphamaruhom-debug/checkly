document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("login-form");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const rememberInput = document.getElementById("remember-me");

    // Arriving straight from registration: say so, and save them retyping their email.
    let justRegistered = null;
    try {
        justRegistered = sessionStorage.getItem("checkly-just-registered");
        sessionStorage.removeItem("checkly-just-registered");
    } catch (err) { /* ignore */ }
    if (justRegistered) {
        emailInput.value = justRegistered;
        const note = document.createElement("div");
        note.className = "auth-success";
        note.setAttribute("role", "status");
        note.textContent = "Account created! Log in with your new password.";
        form.insertBefore(note, form.querySelector(".auth-subheading").nextSibling);
        passwordInput.focus();
    }


    // Eye button: show / hide what's typed in the password box.
    document.querySelectorAll("[data-pw-toggle]").forEach((btn) => {
        const input = document.getElementById(btn.dataset.pwToggle);
        btn.addEventListener("click", () => {
            const reveal = input.type === "password";
            input.type = reveal ? "text" : "password";
            btn.classList.toggle("is-revealed", reveal);
            btn.setAttribute("aria-pressed", String(reveal));
            const label = reveal ? "Hide password" : "Show password";
            btn.setAttribute("aria-label", label);
            btn.title = label;
            input.focus();
        });
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const { user } = await apiPost("/api/login", {
                email: emailInput.value.trim(),
                password: passwordInput.value,
                rememberMe: rememberInput.checked,
            });
            window.location.href = roleHome(user.role);
        } catch (err) {
            showFormError(form, err.message);
        }
    });
});
