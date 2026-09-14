document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector(".main-login-container");
    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const roleSelect = document.getElementById("role");
    const adminCodeGroup = document.getElementById("admin-code-group");
    const adminCodeInput = document.getElementById("adminCode");

    roleSelect.addEventListener("change", () => {
        adminCodeGroup.style.display = roleSelect.value === "admin" ? "block" : "none";
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await apiPost("/api/register", {
                name: nameInput.value.trim(),
                email: emailInput.value.trim(),
                password: passwordInput.value,
                role: roleSelect.value,
                adminCode: adminCodeInput.value,
            });
            window.location.href = "index.html";
        } catch (err) {
            showFormError(form, err.message);
        }
    });
});
