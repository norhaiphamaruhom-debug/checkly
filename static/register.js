document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("register-form");
    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const roleInputs = document.querySelectorAll('input[name="role"]');
    const adminCodeGroup = document.getElementById("admin-code-group");
    const adminCodeInput = document.getElementById("adminCode");

    function getSelectedRole() {
        const checked = document.querySelector('input[name="role"]:checked');
        return checked ? checked.value : "student";
    }

    roleInputs.forEach((input) => {
        input.addEventListener("change", () => {
            adminCodeGroup.hidden = getSelectedRole() !== "admin";
        });
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await apiPost("/api/register", {
                name: nameInput.value.trim(),
                email: emailInput.value.trim(),
                password: passwordInput.value,
                role: getSelectedRole(),
                adminCode: adminCodeInput.value,
            });
            window.location.href = "index.html";
        } catch (err) {
            showFormError(form, err.message);
        }
    });
});
