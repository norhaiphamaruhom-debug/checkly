document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("register-form");
    const review = document.getElementById("review-card");
    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const password2Input = document.getElementById("password2");
    const confirmBtn = document.getElementById("confirm-btn");
    const yearSel = document.getElementById("year");
    const courseSel = document.getElementById("course");
    const courseOther = document.getElementById("course-other");
    const setSel = document.getElementById("set");
    let showPassword = false;

    // Year, course and set come from the same lists the admin uses for classes.
    fillClassSelects(yearSel, courseSel, courseOther, "", "", false);
    fillSetSelect(setSel, "", false);

    function classRequestText() {
        return [yearSel.value, setSel.value, readCourse(courseSel, courseOther)].filter(Boolean).join(" \u00B7 ");
    }

    function showStep(step) {
        form.hidden = step !== "form";
        review.hidden = step !== "review";
        window.scrollTo(0, 0);
        const focusEl = step === "review" ? confirmBtn : nameInput;
        focusEl.focus();
    }

    // Returns an error message, or "" when everything looks fine.
    function validate() {
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        if (!name) return "Please enter your full name.";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Please enter a valid email address.";
        if (passwordInput.value.length < 4) return "Password must be at least 4 characters.";
        if (passwordInput.value !== password2Input.value) return "The two passwords don't match.";
        if (!yearSel.value) return "Please choose your year level.";
        if (!readCourse(courseSel, courseOther)) return "Please choose your course.";
        return "";
    }

    function renderReview() {
        document.getElementById("review-name").textContent = nameInput.value.trim();
        document.getElementById("review-email").textContent = emailInput.value.trim().toLowerCase();
        document.getElementById("review-class").textContent = classRequestText();
        const pw = passwordInput.value;
        document.getElementById("review-password").textContent = showPassword ? pw : "\u2022".repeat(pw.length);
        const toggle = document.getElementById("review-toggle");
        toggle.textContent = showPassword ? "Hide" : "Show";
        toggle.setAttribute("aria-pressed", String(showPassword));
    }

    // Step 1: check the form, then show the review screen. Nothing is sent yet.
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const problem = validate();
        if (problem) {
            showFormError(form, problem);
            return;
        }
        showPassword = false;
        renderReview();
        showStep("review");
    });

    document.getElementById("review-toggle").addEventListener("click", () => {
        showPassword = !showPassword;
        renderReview();
    });


    // Eye buttons: show / hide what's typed in a password box.
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

    // Back to editing - everything they typed is still there.
    document.getElementById("edit-btn").addEventListener("click", () => showStep("form"));

    // Step 2: only now is the account actually created.
    confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        try {
            // Self-signup always creates a student; the server enforces this too.
            await apiPost("/api/register", {
                name: nameInput.value.trim(),
                email: emailInput.value.trim(),
                password: passwordInput.value,
                yearLevel: yearSel.value,
                setName: setSel.value,
                course: readCourse(courseSel, courseOther),
            });
            try { sessionStorage.setItem("checkly-just-registered", emailInput.value.trim().toLowerCase()); } catch (err) { /* ignore */ }
            window.location.href = "index.html";
        } catch (err) {
            // e.g. "email already registered" - send them back to fix it.
            showStep("form");
            showFormError(form, err.message);
            confirmBtn.disabled = false;
        }
    });
});
