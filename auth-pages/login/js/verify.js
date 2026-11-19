/* Email verification: resend (with cooldown) + auto-detect verification. */
(() => {
  "use strict";
  const { $, alertMsg, clearAlert, setLoading, navigate } = UI;
  UI.init();

  const resend = $("resendBtn");
  const cont = $("continueBtn");
  const COOLDOWN = 60;
  const KEY = "verifyResendUntil";
  let poll, tick, canResend = false;

  const mask = (email) => {
    const [u, d] = email.split("@");
    return `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
  };

  function showDone() {
    clearInterval(poll); clearInterval(tick);
    $("waitView").hidden = true; $("doneView").hidden = false;
    $("backLink").hidden = true;
    UI.toast("Email verified!", "success");
  }

  function startCooldown(until) {
    clearInterval(tick);
    const label = resend.querySelector(".btn__label");
    const render = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(tick); resend.disabled = !canResend; label.textContent = "Resend Verification Email"; return; }
      resend.disabled = true; label.textContent = `Resend available in ${left}s`;
    };
    render(); tick = setInterval(render, 500);
  }
  const savedUntil = () => { try { return Number(sessionStorage.getItem(KEY)) || 0; } catch { return 0; } };
  const saveUntil = (t) => { try { sessionStorage.setItem(KEY, String(t)); } catch { /* ignore */ } };

  async function checkNow(manual) {
    try {
      if (await Auth.checkVerified()) { showDone(); return true; }
      if (manual) UI.toast("Not verified yet. Click the link in your email first.", "info");
    } catch (err) {
      if (manual) alertMsg(err.message, err.code === "AUTH_NOT_CONFIGURED" ? "info" : "error");
    }
    return false;
  }

  async function init() {
    if (!Auth.isConfigured()) {
      UI.notConfiguredNotice();
      cont.disabled = true; resend.disabled = true;
      return;
    }
    let user = null;
    try { user = await Auth.getCurrentUser(); } catch (err) { alertMsg(err.message); return; }
    if (!user) {
      alertMsg("You're not signed in. Sign in again to resend the verification email.", "info");
      cont.disabled = true; resend.disabled = true;
      return;
    }
    if (user.emailVerified) { showDone(); return; }

    $("emailPill").textContent = mask(user.email); $("emailPill").hidden = false;
    canResend = true; resend.disabled = false;
    if (savedUntil() > Date.now()) startCooldown(savedUntil());

    poll = setInterval(() => checkNow(false), 6000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNow(false); });
  }

  cont.addEventListener("click", async () => {
    clearAlert();
    setLoading(cont, true, "Checking…");
    await checkNow(true);
    setLoading(cont, false);
  });

  resend.addEventListener("click", async () => {
    clearAlert();
    resend.disabled = true;
    try {
      await Auth.resendVerification();
      UI.toast("Verification email sent. Check your inbox.", "success");
      const until = Date.now() + COOLDOWN * 1000;
      saveUntil(until); startCooldown(until);
    } catch (err) {
      alertMsg(err.message, "error");
      resend.disabled = false;
    }
  });

  $("goBtn").addEventListener("click", () => navigate(AUTH_CONFIG.routes.afterLogin));

  // Back to Login signs the half-registered session out first
  $("backLink").addEventListener("click", () => { Auth.signOut().catch(() => {}); });

  init();
})();
