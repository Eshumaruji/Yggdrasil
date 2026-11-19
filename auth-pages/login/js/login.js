/* Login page: validation + sign-in via window.Auth (see js/auth.js). */
(() => {
  "use strict";
  const { $, V, setError, bind, alertMsg, clearAlert, setLoading, setFormDisabled, navigate } = UI;
  UI.init();

  const form = $("loginForm");
  const idInput = $("identifier");
  const pwInput = $("password");
  const remember = $("remember");
  const submit = $("submitBtn");

  const checkId = bind(idInput, V.identifier);
  const checkPw = bind(pwInput, V.loginPassword);
  if (!Auth.isConfigured()) UI.notConfiguredNotice();

  async function run(task) {
    clearAlert();
    setLoading(submit, true, "Signing in…");
    setFormDisabled(form, true);
    try {
      const res = await task();
      if (res && res.redirectTo) {
        if (res.needsVerification) UI.toast("Please verify your email to continue.", "info");
        navigate(res.redirectTo);
        return; // keep loading state while the page transitions away
      }
    } catch (err) {
      const info = ["AUTH_NOT_CONFIGURED", "PHONE_UNSUPPORTED"].includes(err.code);
      alertMsg(err.message || "Something went wrong. Please try again.", info ? "info" : "error");
      if (!info && err.code === "auth/invalid-credential") { setFormDisabled(form, false); pwInput.select(); }
    }
    setFormDisabled(form, false);
    setLoading(submit, false);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const okId = checkId(), okPw = checkPw();
    if (!okId || !okPw) { (okId ? pwInput : idInput).focus(); return; }
    run(() => Auth.signIn({ identifier: idInput.value.trim(), password: pwInput.value, remember: remember.checked }));
  });

  $("googleBtn").addEventListener("click", () => {
    const btn = $("googleBtn");
    btn.disabled = true;
    clearAlert();
    Auth.googleSignIn({ remember: remember.checked })
      .then((res) => navigate(res.redirectTo))
      .catch((err) => {
        alertMsg(err.message, err.code === "AUTH_NOT_CONFIGURED" ? "info" : "error");
        btn.disabled = false;
      });
  });
  if (!AUTH_CONFIG.googleEnabled) $("altAuth").hidden = true;
})();
