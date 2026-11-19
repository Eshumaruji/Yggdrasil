/* ============================================================
   AUTH ADAPTER (Firebase Authentication, loaded from Google's CDN)

   Pages talk only to window.Auth. If AUTH_CONFIG.firebase is not
   filled in, every call rejects with AuthError("AUTH_NOT_CONFIGURED").
   There is no mock mode and no dummy success path.
   ============================================================ */
(() => {
  "use strict";
  const cfg = window.AUTH_CONFIG;

  class AuthError extends Error {
    constructor(code, message) { super(message); this.name = "AuthError"; this.code = code; }
  }

  const isConfigured = () => Boolean(cfg.firebase && cfg.firebase.apiKey && cfg.firebase.projectId);

  /* ── lazy SDK loading ─────────────────────────────────── */
  let sdkPromise = null;
  function loadSdk() {
    if (!isConfigured()) {
      return Promise.reject(new AuthError("AUTH_NOT_CONFIGURED",
        "Authentication isn't connected yet. Add your Firebase config in js/auth-config.js (see SETUP.md)."));
    }
    if (!sdkPromise) {
      const base = `https://www.gstatic.com/firebasejs/${cfg.firebaseSdkVersion}/`;
      sdkPromise = (async () => {
        const [appM, authM, fsM] = await Promise.all([
          import(base + "firebase-app.js"),
          import(base + "firebase-auth.js"),
          cfg.useFirestore ? import(base + "firebase-firestore.js") : null,
        ]);
        const app = appM.initializeApp(cfg.firebase);
        return { app, auth: authM.getAuth(app), A: authM, db: fsM ? fsM.getFirestore(app) : null, F: fsM };
      })().catch((e) => {
        sdkPromise = null;
        throw new AuthError("NETWORK", "Couldn't load the sign-in service. Check your connection and try again.");
      });
    }
    return sdkPromise;
  }

  /* ── friendly error messages ──────────────────────────── */
  const MESSAGES = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "Incorrect email or password.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/user-disabled": "This account has been disabled. Please contact support.",
    "auth/email-already-in-use": "An account with this email already exists. Try signing in instead.",
    "auth/weak-password": "That password is too weak. Use at least 8 characters with letters and numbers.",
    "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
    "auth/network-request-failed": "Network problem. Check your connection and try again.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/cancelled-popup-request": "Google sign-in was cancelled.",
    "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups for this site and retry.",
    "auth/unauthorized-domain": "This website's domain isn't authorized for sign-in yet (Firebase → Authentication → Settings → Authorized domains).",
    "auth/operation-not-allowed": "This sign-in method isn't enabled in Firebase yet.",
    "auth/requires-recent-login": "Please sign in again to continue.",
  };
  function wrap(e) {
    if (e instanceof AuthError) return e;
    const code = (e && e.code) || "unknown";
    return new AuthError(code, MESSAGES[code] || "Something went wrong. Please try again.");
  }
  const guarded = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw wrap(e); } };

  /* ── helpers ──────────────────────────────────────────── */
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const actionSettings = () =>
    cfg.siteUrl ? { url: new URL(cfg.routes.login, cfg.siteUrl).href } : undefined;

  // Profile doc. `role` is ALWAYS "donor" here; privileged roles are granted
  // server-side only (custom claims / admin). Staff choice is stored as a *request*.
  async function ensureProfile(sdk, user, extra = {}) {
    if (!sdk.db) return;
    const { doc, getDoc, setDoc, serverTimestamp } = sdk.F;
    const ref = doc(sdk.db, "users", user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    const requested = cfg.publicRoles.includes(extra.requestedRole) ? extra.requestedRole : "donor";
    await setDoc(ref, {
      name: extra.name || user.displayName || "",
      email: user.email || "",
      phone: extra.phone || "",
      role: "donor",
      requestedRole: requested,
      createdAt: serverTimestamp(),
    });
  }

  /* ── public API ───────────────────────────────────────── */
  async function signIn({ identifier, password, remember }) {
    if (!isEmail(identifier)) {
      throw new AuthError("PHONE_UNSUPPORTED",
        "Mobile-number sign-in (OTP) isn't enabled yet. Please sign in with your email address.");
    }
    const sdk = await loadSdk();
    const { A, auth } = sdk;
    await A.setPersistence(auth, remember ? A.browserLocalPersistence : A.browserSessionPersistence);
    const { user } = await A.signInWithEmailAndPassword(auth, identifier, password);
    if (!user.emailVerified) return { redirectTo: cfg.routes.verifyEmail, needsVerification: true };
    return { redirectTo: cfg.routes.afterLogin };
  }

  async function googleSignIn({ remember = true } = {}) {
    const sdk = await loadSdk();
    const { A, auth } = sdk;
    await A.setPersistence(auth, remember ? A.browserLocalPersistence : A.browserSessionPersistence);
    const { user } = await A.signInWithPopup(auth, new A.GoogleAuthProvider());
    try { await ensureProfile(sdk, user); } catch (e) { console.warn("Profile creation failed:", e); }
    return { redirectTo: cfg.routes.afterLogin };
  }

  async function register({ name, email, phone, password, role }) {
    if (role && !cfg.publicRoles.includes(role)) {
      throw new AuthError("ROLE_NOT_ALLOWED", "That account type can't be created from the public sign-up page.");
    }
    const sdk = await loadSdk();
    const { A, auth } = sdk;
    const { user } = await A.createUserWithEmailAndPassword(auth, email, password);
    let warning = "";
    try { await A.updateProfile(user, { displayName: name }); } catch (e) { console.warn(e); }
    try { await ensureProfile(sdk, user, { name, phone, requestedRole: role }); }
    catch (e) { console.warn("Profile creation failed:", e); warning = "Your account was created, but your profile details couldn't be saved yet."; }
    try { await A.sendEmailVerification(user, actionSettings()); }
    catch (e) { warning = "Your account was created, but we couldn't send the verification email. Use “Resend” on the next page."; }
    return { redirectTo: cfg.routes.verifyEmail, warning };
  }

  // Always resolves the same way, so the page can't be used to discover which emails have accounts.
  async function sendPasswordReset(email) {
    const sdk = await loadSdk();
    try {
      await sdk.A.sendPasswordResetEmail(sdk.auth, email, actionSettings());
    } catch (e) {
      if (e && e.code === "auth/user-not-found") return; // deliberately indistinguishable
      throw e;
    }
  }

  async function getCurrentUser() {
    const sdk = await loadSdk();
    await sdk.auth.authStateReady();
    return sdk.auth.currentUser;
  }

  async function resendVerification() {
    const sdk = await loadSdk();
    await sdk.auth.authStateReady();
    if (!sdk.auth.currentUser) throw new AuthError("NO_USER", "Please sign in again to resend the verification email.");
    await sdk.A.sendEmailVerification(sdk.auth.currentUser, actionSettings());
  }

  // Re-reads the account from Firebase; true once the email link has been clicked.
  async function checkVerified() {
    const sdk = await loadSdk();
    await sdk.auth.authStateReady();
    const u = sdk.auth.currentUser;
    if (!u) return false;
    await u.reload();
    if (u.emailVerified) await u.getIdToken(true); // refresh claims
    return u.emailVerified;
  }

  async function signOut() {
    if (!isConfigured()) return;
    const sdk = await loadSdk();
    await sdk.A.signOut(sdk.auth);
  }

  /**
   * Route guard for protected pages (see js/guard.js).
   * Redirects to login when signed out, to verify-email when unverified.
   */
  async function requireAuth({ requireVerified = true } = {}) {
    const user = await getCurrentUser();
    if (!user) { window.location.replace(cfg.routes.login); return null; }
    if (requireVerified && !user.emailVerified) { window.location.replace(cfg.routes.verifyEmail); return null; }
    return user;
  }

  window.Auth = {
    AuthError, isConfigured, isEmail,
    signIn: guarded(signIn),
    googleSignIn: guarded(googleSignIn),
    register: guarded(register),
    sendPasswordReset: guarded(sendPasswordReset),
    getCurrentUser: guarded(getCurrentUser),
    resendVerification: guarded(resendVerification),
    checkVerified: guarded(checkVerified),
    signOut: guarded(signOut),
    requireAuth: guarded(requireAuth),
  };
})();
