/* ============================================================
   AUTH ADAPTER  –  the ONLY file you need to edit to connect
   the login page to your backend.

   No authentication is configured yet, so signIn() will reject
   with code "AUTH_NOT_CONFIGURED". It never reports a fake
   success. To connect your real backend, do ONE of:

   A) REST endpoint: set `loginEndpoint` below. The page will
      POST JSON { identifier, password, remember } and treat any
      2xx response as success.

   B) Custom logic (Firebase, Supabase, NextAuth, etc.): replace
      the body of `signIn` with your SDK call. Resolve on success,
      throw `new AuthError(code, message)` on failure.
   ============================================================ */

window.AUTH_CONFIG = {
  // TODO(backend): e.g. "/api/auth/login"
  loginEndpoint: null,

  // TODO(backend): where to go after a successful login, e.g. "/dashboard"
  redirectAfterLogin: "/dashboard",

  // Set true ONLY when Google OAuth is implemented in googleSignIn() below.
  // While false, the "OR / Continue with Google" block stays hidden.
  googleEnabled: false,

  // Page links (adjust to your router paths)
  registerUrl: "register.html",
  forgotPasswordUrl: "forgot-password.html",

  // Minimum password length checked client-side. Match your backend rule.
  minPasswordLength: 8,
};

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * Sign the user in.
 * @param {{identifier:string, password:string, remember:boolean}} creds
 * @returns {Promise<{redirectTo?:string}>}
 */
async function signIn(creds) {
  const { loginEndpoint, redirectAfterLogin } = window.AUTH_CONFIG;

  if (!loginEndpoint) {
    throw new AuthError(
      "AUTH_NOT_CONFIGURED",
      "Sign-in isn't connected to a backend yet. Set loginEndpoint in js/auth.js."
    );
  }

  let res;
  try {
    res = await fetch(loginEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include", // lets the server set a session cookie
      body: JSON.stringify(creds),
    });
  } catch {
    throw new AuthError("NETWORK", "Can't reach the server. Check your connection and try again.");
  }

  if (res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* empty body is fine */ }
    return { redirectTo: data.redirectTo || redirectAfterLogin };
  }

  // Map common statuses to friendly messages. Prefer the server's own message.
  let serverMsg = "";
  try { serverMsg = (await res.json()).message || ""; } catch { /* ignore */ }

  if (res.status === 401 || res.status === 400) {
    throw new AuthError("INVALID_CREDENTIALS", serverMsg || "Incorrect email/mobile number or password.");
  }
  if (res.status === 429) {
    throw new AuthError("RATE_LIMITED", serverMsg || "Too many attempts. Please wait a moment and try again.");
  }
  throw new AuthError("SERVER", serverMsg || "Something went wrong on our side. Please try again.");
}

/**
 * Google sign-in. Only wired up when AUTH_CONFIG.googleEnabled is true.
 * TODO(backend): implement with your OAuth flow (e.g. redirect to
 * /api/auth/google, or Google Identity Services + token exchange).
 */
async function googleSignIn() {
  throw new AuthError("AUTH_NOT_CONFIGURED", "Google sign-in is not implemented yet.");
}

window.Auth = { signIn, googleSignIn, AuthError };
