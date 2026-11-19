/* Shared UI helpers for all auth pages: validation, errors, alerts,
   toasts, loading state, password toggles, strength meter, transitions. */
window.UI = (() => {
  "use strict";
  const cfg = window.AUTH_CONFIG;
  const $ = (id) => document.getElementById(id);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* ── validators: each returns "" when valid, else a message ── */
  const phoneCheck = (v) => {
    if (!/^\+?[\d\s\-()]+$/.test(v)) return "Enter a valid mobile number, like +91 98765 43210.";
    const d = v.replace(/\D/g, "");
    return d.length < 7 || d.length > 15 ? "Mobile number should have 7 to 15 digits." : "";
  };
  const V = {
    email(v) {
      v = v.trim();
      if (!v) return "Please enter your email address.";
      return EMAIL_RE.test(v) ? "" : "Enter a valid email address, like name@example.com.";
    },
    phone(v) {
      v = v.trim();
      return v ? phoneCheck(v) : "Please enter your mobile number.";
    },
    name(v) {
      v = v.trim();
      if (!v) return "Please enter your full name.";
      if (v.length < 2) return "Name is too short.";
      return /^[\p{L}][\p{L}\s.'’-]*$/u.test(v) ? "" : "Name can only contain letters, spaces and . ' -";
    },
    identifier(v) {
      v = v.trim();
      if (!v) return "Please enter your email or mobile number.";
      if (v.includes("@")) return EMAIL_RE.test(v) ? "" : "Enter a valid email address, like name@example.com.";
      return phoneCheck(v);
    },
    loginPassword(v) {
      if (!v) return "Please enter your password.";
      return v.length < cfg.minPasswordLength ? `Password must be at least ${cfg.minPasswordLength} characters.` : "";
    },
    newPassword(v) {
      if (!v) return "Please create a password.";
      if (v.length < cfg.minPasswordLength) return `Use at least ${cfg.minPasswordLength} characters.`;
      if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return "Include at least one letter and one number.";
      return "";
    },
    confirm: (getPw) => (v) => (!v ? "Please confirm your password." : v !== getPw() ? "Passwords do not match." : ""),
    checked: (msg) => (_v, el) => (el.checked ? "" : msg),
  };

  /* ── field errors ── */
  function setError(input, message) {
    const field = input.closest(".field");
    field.classList.toggle("has-error", Boolean(message));
    const err = $(`${input.id}-err`);
    if (err) err.textContent = message;
    input.setAttribute("aria-invalid", message ? "true" : "false");
    return !message;
  }
  // Validate on blur; once errored, re-validate live so it clears as soon as it's fixed.
  function bind(input, validator, extraOnInput) {
    const run = () => setError(input, validator(input.type === "checkbox" ? "" : input.value, input));
    if (input.type !== "checkbox") input.addEventListener("blur", () => { if (input.value) run(); });
    const live = () => {
      clearAlert();
      if (input.closest(".field").classList.contains("has-error")) run();
      if (extraOnInput) extraOnInput();
    };
    input.addEventListener(input.type === "checkbox" ? "change" : "input", live);
    return run;
  }

  /* ── inline alert (#formAlert) ── */
  function alertMsg(message, kind = "error") {
    const box = $("formAlert");
    $("formAlertText").textContent = message;
    box.classList.toggle("alert--info", kind === "info");
    box.classList.toggle("alert--ok", kind === "success");
    box.hidden = false;
    box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
  }
  function clearAlert() { const b = $("formAlert"); if (b) b.hidden = true; }

  /* ── toast ── */
  function toast(message, kind = "success", ms = 4200) {
    let host = $("toasts");
    if (!host) { host = document.createElement("div"); host.id = "toasts"; host.className = "toasts"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
    const t = document.createElement("div");
    t.className = `toast toast--${kind}`;
    t.setAttribute("role", kind === "error" ? "alert" : "status");
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => { t.classList.add("is-out"); setTimeout(() => t.remove(), 300); }, ms);
  }

  /* ── loading state for a submit button ── */
  function setLoading(btn, on, loadingLabel) {
    const label = btn.querySelector(".btn__label");
    if (!btn.dataset.label) btn.dataset.label = label.textContent;
    btn.classList.toggle("is-loading", on);
    btn.disabled = on;
    btn.setAttribute("aria-busy", String(on));
    label.textContent = on ? loadingLabel : btn.dataset.label;
  }
  function setFormDisabled(form, on) {
    form.querySelectorAll("input, select, textarea").forEach((el) => (el.disabled = on));
  }

  /* ── password show/hide: <button class="toggle" data-for="inputId"> ── */
  function wireToggles() {
    document.querySelectorAll(".toggle[data-for]").forEach((btn) => {
      const input = $(btn.dataset.for);
      btn.addEventListener("click", () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-pressed", String(show));
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        input.focus({ preventScroll: true });
      });
    });
  }

  /* ── password strength: returns {score 0-4, label} ── */
  function strength(pw) {
    if (!pw) return { score: 0, label: "" };
    let s = 0;
    if (pw.length >= cfg.minPasswordLength) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    if (pw.length < cfg.minPasswordLength) s = Math.min(s, 1);
    return { score: s, label: ["Too short", "Weak", "Fair", "Good", "Strong"][s] };
  }
  function wireStrength(input, meter) {
    const label = meter.querySelector(".strength__label");
    const update = () => {
      const { score, label: text } = strength(input.value);
      meter.dataset.score = String(input.value ? score : "");
      label.textContent = input.value ? text : "";
    };
    input.addEventListener("input", update);
    update();
  }

  /* ── notice shown when Firebase isn't configured ── */
  function notConfiguredNotice() {
    if (!window.Auth.isConfigured()) {
      alertMsg("Authentication isn't connected yet, so nothing will be sent. Add your Firebase config in js/auth-config.js (see SETUP.md).", "info");
    }
  }

  /* ── page transitions ── */
  function navigate(url) {
    const page = document.querySelector(".page");
    if (page) page.classList.add("is-leaving");
    setTimeout(() => { window.location.href = url; }, 300);
  }
  function wireNav() {
    document.querySelectorAll("a[data-route]").forEach((a) => {
      a.href = cfg.routes[a.dataset.route];
      a.addEventListener("click", (e) => {
        if (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(a.href);
      });
    });
    window.addEventListener("pageshow", () => { const p = document.querySelector(".page"); if (p) p.classList.remove("is-leaving"); });
  }

  /* ── decorative background (injected so pages stay small) ── */
  function mountBackground() {
    if (document.querySelector(".bg")) return;
    const bg = document.createElement("div");
    bg.className = "bg"; bg.setAttribute("aria-hidden", "true");
    bg.innerHTML = '<span class="blob blob--a"></span><span class="blob blob--b"></span>' +
      [1, 2, 3, 4, 5, 6].map((n) => `<span class="drop drop--${n}"></span>`).join("");
    document.body.prepend(bg);
  }

  function init() { mountBackground(); wireNav(); wireToggles(); }

  return { $, V, setError, bind, alertMsg, clearAlert, toast, setLoading, setFormDisabled, wireStrength, strength, notConfiguredNotice, navigate, init };
})();
