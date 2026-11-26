/**
 * Firebase WEB config + app settings.
 *
 * Firebase Console > Project settings > General > "Your apps" > Web app > SDK config.
 * NOTE: this is NOT serviceAccountKey.json. That file is a private admin key
 * for the FastAPI backend and must never be shipped to a browser.
 *
 * Also enable the sign-in methods in Console > Authentication > Sign-in method:
 * Email/Password and Google. Add your domain under Authentication > Settings >
 * Authorised domains (localhost is allowed by default).
 */
export const firebaseConfig = {
  apiKey: "AIzaSyARfXJ2JL7LP0eHA1ekXL1F3IOcRKyfaL8",
  authDomain: "yggdrasil-4c4bf.firebaseapp.com",
  projectId: "yggdrasil-4c4bf",
  appId: "1:903694396820:web:be65dfc6e1dbe599e9b381",
};

/** FastAPI base URL (uvicorn main:app --reload). */
export const API_BASE = "http://127.0.0.1:8000";

/**
 * Public endpoint for the landing-page map. Expected response:
 *   { blood_banks: [{ id, name, address, phone, lat, lng, distance_km, ... }] }
 * Your existing /requestors/{id}/nearby-blood-banks returns this shape but needs
 * a requestor id, so add a public route such as GET /blood-banks/nearby?lat&lng&radius_km.
 * Until it exists the page shows clearly-labelled demo data.
 */
export const NEARBY_ENDPOINT = "/blood-banks/nearby";
export const SEARCH_RADIUS_KM = 25; // matches NEARBY_RADIUS_KM in requestors.py

/** Where each role goes after sign-in. */
export const ROLE_ROUTES = {
  donor: "donor.html",
  blood_bank: "blood-bank.html",
  requestor: "requestor.html",
};
export const ROLE_LABELS = { donor: "Donor", blood_bank: "Blood bank", requestor: "Requestor" };
