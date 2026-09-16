document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("login-form");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const rememberInput = document.getElementById("remember-me");

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
