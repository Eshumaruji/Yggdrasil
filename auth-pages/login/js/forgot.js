/* Forgot password: sends a real reset email through Firebase. */
(() => {
  "use strict";
  const { $, V, bind, alertMsg, clearAlert, setLoading } = UI;
  UI.init();

  const form = $("forgotForm");
  const email = $("email");
  const submit = $("submitBtn");
  const check = bind(email, V.email);
  if (!Auth.isConfigured()) UI.notConfiguredNotice();

  async function send(btn, loadingLabel) {
    clearAlert();
    setLoading(btn, true, loadingLabel);
    try {
      await Auth.sendPasswordReset(email.value.trim());
      setLoading(btn, false);
      $("sentTo").textContent = email.value.trim();
      $("formView").hidden = true;
      $("doneView").hidden = false;
      UI.toast("Reset link sent. Check your inbox.", "success");
      startCooldown();
    } catch (err) {
      const info = err.code === "AUTH_NOT_CONFIGURED";
      if ($("doneView").hidden) alertMsg(err.message, info ? "info" : "error");
      else UI.toast(err.message, info ? "info" : "error");
      setLoading(btn, false);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!check()) { email.focus(); return; }
    send(submit, "Sending…");
  });

  // "Send again" with a 30s cooldown to avoid spamming
  const resend = $("resendBtn");
  let timer;
  function startCooldown(seconds = 30) {
    clearInterval(timer);
    const label = resend.querySelector(".btn__label");
    let left = seconds;
    resend.disabled = true;
    const tick = () => {
      if (left <= 0) { clearInterval(timer); resend.disabled = false; label.textContent = "Send again"; delete resend.dataset.label; return; }
      label.textContent = `Send again in ${left}s`; left--;
    };
    tick(); timer = setInterval(tick, 1000);
  }
  resend.addEventListener("click", () => send(resend, "Sending…"));
})();
