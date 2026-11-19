/* Registration page: validation, strength meter, role picker, sign-up. */
(() => {
  "use strict";
  const { $, V, bind, alertMsg, clearAlert, setLoading, setFormDisabled, navigate, setError } = UI;
  UI.init();

  const form = $("registerForm");
  const submit = $("submitBtn");
  const f = { name: $("name"), email: $("email"), phone: $("phone"), password: $("password"), confirm: $("confirm"), terms: $("terms") };

  UI.wireStrength(f.password, $("strength"));

  const checks = [
    bind(f.name, V.name),
    bind(f.email, V.email),
    bind(f.phone, V.phone),
    bind(f.password, V.newPassword, () => {
      // keep "confirm" in sync when the password changes after it was filled in
      if (f.confirm.value) setError(f.confirm, V.confirm(() => f.password.value)(f.confirm.value));
    }),
    bind(f.confirm, V.confirm(() => f.password.value)),
    bind(f.terms, V.checked("Please accept the Terms and Privacy Policy to continue.")),
  ];

  // Public sign-up can only ever request donor or staff; admin is never offered.
  const role = () => form.querySelector('input[name="role"]:checked').value;
  form.querySelectorAll('input[name="role"]').forEach((r) =>
    r.addEventListener("change", () => { $("roleHint").hidden = role() !== "staff"; })
  );

  if (!Auth.isConfigured()) UI.notConfiguredNotice();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();
    const results = checks.map((c) => c());
    const firstBad = results.indexOf(false);
    if (firstBad !== -1) { Object.values(f)[firstBad].focus(); return; }

    setLoading(submit, true, "Creating account…");
    setFormDisabled(form, true);
    try {
      const res = await Auth.register({
        name: f.name.value.trim().replace(/\s+/g, " "),
        email: f.email.value.trim(),
        phone: f.phone.value.trim(),
        password: f.password.value,
        role: role(),
      });
      UI.toast("Account created! Check your email to verify it.", "success");
      if (res.warning) UI.toast(res.warning, "info", 7000);
      navigate(res.redirectTo);
      return;
    } catch (err) {
      const info = err.code === "AUTH_NOT_CONFIGURED";
      alertMsg(err.message || "Something went wrong. Please try again.", info ? "info" : "error");
      if (err.code === "auth/email-already-in-use") setError(f.email, "This email is already registered.");
    }
    setFormDisabled(form, false);
    setLoading(submit, false);
  });

  $("googleBtn").addEventListener("click", () => {
    const btn = $("googleBtn");
    btn.disabled = true;
    clearAlert();
    Auth.googleSignIn()
      .then((res) => navigate(res.redirectTo))
      .catch((err) => {
        alertMsg(err.message, err.code === "AUTH_NOT_CONFIGURED" ? "info" : "error");
        btn.disabled = false;
      });
  });
  if (!AUTH_CONFIG.googleEnabled) $("altAuth").hidden = true;
})();
