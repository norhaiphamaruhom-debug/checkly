document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector(".main-login-container");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const { user } = await apiPost("/api/login", {
                email: emailInput.value.trim(),
                password: passwordInput.value,
            });
            window.location.href = roleHome(user.role);
        } catch (err) {
            showFormError(form, err.message);
        }
    });
});
