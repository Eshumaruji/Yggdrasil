/* Route guard. Add to the <head> of every protected page, AFTER
   auth-config.js and auth.js:

     <script src="js/auth-config.js"></script>
     <script src="js/auth.js"></script>
     <script src="js/guard.js"></script>

   The page stays hidden until the user is confirmed signed in AND
   email-verified; otherwise they are redirected. This is a UX layer
   only: enforce access on the server / Firestore rules too. */
(() => {
  const root = document.documentElement;
  root.style.visibility = "hidden";
  window.Auth.requireAuth({ requireVerified: true })
    .then((user) => { if (user) root.style.visibility = ""; })
    .catch(() => window.location.replace(window.AUTH_CONFIG.routes.login));
})();
