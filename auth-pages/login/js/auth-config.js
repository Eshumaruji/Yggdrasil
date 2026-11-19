/* ============================================================
   AUTH CONFIGURATION  –  edit this file to connect your project.

   Public Firebase web config is NOT a secret (it identifies your
   project; security comes from Firebase Auth settings, authorized
   domains and Firestore rules). Never put service-account keys,
   admin SDK credentials or any private key in front-end code.

   Leave `firebase` as null until you have a project: the pages
   then show a clear "not configured" notice and NEVER pretend
   a sign-in succeeded. See SETUP.md.
   ============================================================ */

window.AUTH_CONFIG = {
  // Paste the object from Firebase Console → Project settings → Your apps → Web app.
  // Example shape:
  // firebase: { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." },
  firebase: null,

  // Store each user's profile (name, phone, requested role) in Firestore "users/{uid}".
  // Requires Firestore enabled + firestore.rules deployed. Set false to skip profiles.
  useFirestore: true,

  // Pinned Firebase JS SDK version loaded from Google's CDN (no npm install needed).
  firebaseSdkVersion: "11.0.2",

  // Public base URL used for the "continue" link after email actions (optional).
  // Must be in Firebase Console → Authentication → Settings → Authorized domains.
  siteUrl: null,

  // Routes (change to match your router)
  routes: {
    login: "index.html",
    register: "register.html",
    forgotPassword: "forgot-password.html",
    verifyEmail: "verify-email.html",
    afterLogin: "/dashboard",       // TODO: your protected home page
    terms: "terms.html",
    privacy: "privacy.html",
  },

  // Client-side password rule. Keep in sync with Firebase password policy.
  minPasswordLength: 8,

  // Roles users may pick on PUBLIC sign-up. "admin" is intentionally absent and
  // can never be self-assigned (see firestore.rules and SETUP.md).
  publicRoles: ["donor", "staff"],

  // Show the Google button. It tells the user when auth isn't configured yet.
  googleEnabled: true,
};
