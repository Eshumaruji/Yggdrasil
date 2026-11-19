# Authentication setup

The UI is complete, but sign-in only works once Firebase is connected.
Until then every page shows a "not connected" notice and nothing is faked.

## 1. Create the Firebase project (about 10 minutes)
1. Firebase Console → **Add project**, then **Add app → Web (</>)**.
2. Copy the config object into `js/auth-config.js` → `firebase: { ... }`.
3. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
4. **Authentication → Settings → Authorized domains:** add your site's domain
   (`localhost` is there by default). Google sign-in and email links fail on unlisted domains.
5. **Authentication → Templates:** customise the verification and password-reset emails.
6. **Firestore Database:** create it, then publish `firestore.rules` (Rules tab).
   Skip this by setting `useFirestore: false` (profiles/roles will not be stored).

## 2. Run it from a web server
Firebase will not work from a `file://` page. Use any static server, e.g.
`python3 -m http.server 8000` and open http://localhost:8000/.

## 3. Protect private pages
Add to the `<head>` of every protected page (after `auth-config.js` and `auth.js`):
```html
<script src="js/guard.js"></script>
```
Signed-out users go to login; unverified users go to the verify-email page.
This is a UX layer. Also enforce access with Firestore rules / your server.

## 4. Roles and admin access
- Public sign-up offers only **Blood Donor** and **Blood Bank Staff**; "admin" cannot be requested.
- Everyone starts with `role: "donor"`. Choosing Staff only stores `requestedRole: "staff"`.
  `firestore.rules` stops users from changing `role` themselves.
- Grant real staff/admin power server-side only (Firebase Admin SDK custom claims, e.g.
  `setCustomUserClaims(uid, { role: "staff" })`), and check the claim in rules/backend.
- Create the first admin by hand (Admin SDK script or Console), never through the sign-up form.

## 5. Things still to decide / build
- `terms.html` and `privacy.html` (linked from sign-up) and your post-login page (`routes.afterLogin`).
- Phone (OTP) sign-in is not implemented; mobile numbers are collected at sign-up only.
  Add it with Firebase Phone Auth (needs reCAPTCHA + Blaze plan) if you want it.
- Security hardening in the Firebase Console: enable **App Check**, set a password policy,
  and consider email-enumeration protection (Authentication → Settings).
- Passwords are handled entirely by Firebase (hashed server-side); this code never stores them.
