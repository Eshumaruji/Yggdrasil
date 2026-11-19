/* Login page behaviour: validation, password toggle, loading state,
   page transitions. Talks to the backend only through js/auth.js. */
(() => {
  "use strict";

  const cfg = window.AUTH_CONFIG;
  const { signIn, googleSignIn, AuthError } = window.Auth;

  const $ = (id) => document.getElementById(id);
  const form = $("loginForm");
  const idInput = $("identifier");
  const pwInput = $("password");
  const rememberInput = $("remember");
  const submitBtn = $("submitBtn");
  const alertBox = $("formAlert");
  const alertText = $("formAlertText");

  // Wire configurable links
  $("registerLink").href = cfg.registerUrl;
  $("forgotLink").href = cfg.forgotPasswordUrl;
  if (cfg.googleEnabled) $("altAuth").hidden = false;

  /* ── Validation ───────────────────────────────────────── */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function validateIdentifier(raw) {
    const v = raw.trim();
    if (!v) return "Please enter your email or mobile number.";
    if (v.includes("@")) {
      return EMAIL_RE.test(v) ? "" : "Enter a valid email address, like name@example.com.";
    }
    // Mobile: optional +, then digits (spaces, dashes, brackets allowed). 7–15 digits.
    if (!/^\+?[\d\s\-()]+$/.test(v)) return "Enter a valid email address or mobile number.";
    const digits = v.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return "Mobile number should have 7 to 15 digits.";
    return "";
  }

  function validatePassword(v) {
    if (!v) return "Please enter your password.";
    if (v.length < cfg.minPasswordLength) return `Password must be at least ${cfg.minPasswordLength} characters.`;
    return "";
  }

  function setError(input, message) {
    const field = input.closest(".field");
    field.classList.toggle("has-error", Boolean(message));
    $(`${input.id}-err`).textContent = message;
    input.setAttribute("aria-invalid", message ? "true" : "false");
    return !message;
  }

  const checkIdentifier = () => setError(idInput, validateIdentifier(idInput.value));
  const checkPassword = () => setError(pwInput, validatePassword(pwInput.value));

  // Validate on blur; once a field has an error, re-validate live so it clears as soon as it's fixed.
  idInput.addEventListener("blur", () => idInput.value && checkIdentifier());
  pwInput.addEventListener("blur", () => pwInput.value && checkPassword());
  idInput.addEventListener("input", () => { hideAlert(); if (idInput.closest(".field").classList.contains("has-error")) checkIdentifier(); });
  pwInput.addEventListener("input", () => { hideAlert(); if (pwInput.closest(".field").classList.contains("has-error")) checkPassword(); });

  /* ── Alerts ───────────────────────────────────────────── */
  function showAlert(message, kind = "error") {
    alertText.textContent = message;
    alertBox.classList.toggle("alert--info", kind === "info");
    alertBox.hidden = false;
    // restart shake animation
    alertBox.style.animation = "none"; void alertBox.offsetWidth; alertBox.style.animation = "";
  }
  function hideAlert() { alertBox.hidden = true; }

  /* ── Password visibility ──────────────────────────────── */
  const toggle = $("togglePw");
  toggle.addEventListener("click", () => {
    const show = pwInput.type === "password";
    pwInput.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    pwInput.focus({ preventScroll: true });
  });

  /* ── Loading state ────────────────────────────────────── */
  function setLoading(on) {
    submitBtn.classList.toggle("is-loading", on);
    submitBtn.disabled = on;
    submitBtn.setAttribute("aria-busy", String(on));
    submitBtn.querySelector(".btn__label").textContent = on ? "Signing in…" : "Sign In";
    [idInput, pwInput, rememberInput].forEach((el) => (el.disabled = on));
  }

  /* ── Submit ───────────────────────────────────────────── */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const okId = checkIdentifier();
    const okPw = checkPassword();
    if (!okId || !okPw) {
      (okId ? pwInput : idInput).focus();
      return;
    }

    setLoading(true);
    try {
      const result = await signIn({
        identifier: idInput.value.trim(),
        password: pwInput.value,
        remember: rememberInput.checked,
      });
      if (result && result.redirectTo) {
        navigate(result.redirectTo);
        return; // keep loading state while the page transitions away
      }
      showAlert("Signed in, but no destination was configured. Set redirectAfterLogin in js/auth.js.", "info");
    } catch (err) {
      if (err instanceof AuthError && err.code === "AUTH_NOT_CONFIGURED") {
        showAlert(err.message, "info");
      } else {
        showAlert((err && err.message) || "Something went wrong. Please try again.");
        if (err instanceof AuthError && err.code === "INVALID_CREDENTIALS") pwInput.select();
      }
    }
    setLoading(false);
  });

  /* ── Google ───────────────────────────────────────────── */
  $("googleBtn").addEventListener("click", async () => {
    hideAlert();
    try { await googleSignIn(); }
    catch (err) { showAlert(err.message, err.code === "AUTH_NOT_CONFIGURED" ? "info" : "error"); }
  });

  /* ── Smooth page transitions ──────────────────────────── */
  const page = $("page");
  function navigate(url) {
    page.classList.add("is-leaving");
    setTimeout(() => { window.location.href = url; }, 300);
  }
  [$("registerLink"), $("forgotLink")].forEach((a) =>
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(a.href);
    })
  );
  // Restore from bfcache without the fade-out stuck on
  window.addEventListener("pageshow", () => page.classList.remove("is-leaving"));
})();
