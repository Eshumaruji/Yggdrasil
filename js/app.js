/**
 * Yggdrasil landing page logic:
 *   1. Role selection (saved in localStorage)
 *   2. Firebase Auth (Google, email/password, auth state)
 *   3. Leaflet map + nearby blood banks
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  firebaseConfig, API_BASE, NEARBY_ENDPOINT, SEARCH_RADIUS_KM, ROLE_ROUTES, ROLE_LABELS,
} from "./firebase-config.js";

const $ = (s) => document.querySelector(s);
const ROLE_KEY = "yggdrasil.role";
$("#year").textContent = new Date().getFullYear();

/* ───────────── 1. Role selection ───────────── */
const roleCards = [...document.querySelectorAll(".role")];
let role = localStorage.getItem(ROLE_KEY);

function setRole(next) {
  role = next;
  if (next) localStorage.setItem(ROLE_KEY, next);
  roleCards.forEach((c) => c.setAttribute("aria-checked", String(c.dataset.role === next)));
  $("#roleHint").textContent = next
    ? `Signing in as ${ROLE_LABELS[next]}.`
    : "Select a role on the left, then sign in.";
  $("#registerLink").href = next ? `register.html?role=${next}` : "register.html";
  renderSignedInRole();
}
roleCards.forEach((c) => c.addEventListener("click", () => {
  setRole(c.dataset.role);
  $("#authCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}));

/* ───────────── 2. Firebase Auth ───────────── */
const configured = !firebaseConfig.apiKey.startsWith("YOUR_");
const auth = configured ? getAuth(initializeApp(firebaseConfig)) : null;

const alertBox = $("#formAlert");
function showAlert(msg) { $("#formAlertText").textContent = msg; alertBox.hidden = !msg; }
function setBusy(on) {
  const b = $("#submitBtn");
  b.classList.toggle("is-loading", on);
  b.disabled = on;
}

const AUTH_ERRORS = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/user-not-found": "No account found for this email. Create an account first.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/popup-closed-by-user": "Google sign-in was closed before finishing.",
  "auth/popup-blocked": "Your browser blocked the Google pop-up. Allow pop-ups and retry.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
};
const authMessage = (e) => AUTH_ERRORS[e.code] || "Sign-in failed. Please try again.";

function requireSetup() {
  if (configured) return true;
  showAlert("Firebase isn't set up yet. Add your web config in js/firebase-config.js.");
  return false;
}

$("#togglePw").addEventListener("click", (e) => {
  const input = $("#password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  e.currentTarget.textContent = show ? "Hide" : "Show";
  e.currentTarget.setAttribute("aria-pressed", String(show));
  e.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("");
  const email = $("#email").value.trim();
  const password = $("#password").value;
  $("#email-err").textContent = email ? "" : "Enter your email.";
  $("#password-err").textContent = password ? "" : "Enter your password.";
  if (!email || !password || !requireSetup()) return;

  setBusy(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    showAlert(authMessage(err));
  } finally { setBusy(false); }
});

$("#googleBtn").addEventListener("click", async () => {
  showAlert("");
  if (!requireSetup()) return;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) { showAlert(authMessage(err)); }
});

$("#signOutBtn").addEventListener("click", () => auth && signOut(auth));

function renderSignedInRole() {
  $("#signedInRole").textContent = role
    ? `Role: ${ROLE_LABELS[role]}`
    : "Pick a role on the left to open your portal.";
  const btn = $("#continueBtn");
  btn.textContent = role ? `Open ${ROLE_LABELS[role]} portal` : "Choose a role first";
  btn.href = role ? ROLE_ROUTES[role] : "#portals";
}

// Fires on load and after every sign-in / sign-out.
if (auth) {
  onAuthStateChanged(auth, async (user) => {
    $("#signedOut").hidden = !!user;
    $("#signedIn").hidden = !user;
    if (!user) return;
    const name = user.displayName || user.email || "Signed-in user";
    $("#userName").textContent = name;
    $("#userEmail").textContent = user.email || "";
    $("#userAvatar").textContent = name[0].toUpperCase();
    const photo = $("#userPhoto");
    photo.hidden = !user.photoURL;
    if (user.photoURL) { photo.src = user.photoURL; $("#userAvatar").hidden = true; }
    renderSignedInRole();
    // Send this token as "Authorization: Bearer <token>" once the backend verifies it.
    window.yggdrasilIdToken = await user.getIdToken();
  });
}
setRole(role in ROLE_ROUTES ? role : null);

/* ───────────── 3. Map + nearby blood banks ───────────── */
const DEFAULT_CENTER = [12.2958, 76.6394]; // Mysuru; used until the user shares location
const map = L.map("map", { scrollWheelZoom: false }).setView(DEFAULT_CENTER, 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.on("focus", () => map.scrollWheelZoom.enable());
map.on("blur", () => map.scrollWheelZoom.disable());

const markers = L.layerGroup().addTo(map);
let youMarker = null;
const bloodIcon = L.divIcon({ className: "pin", html: "<span></span>", iconSize: [26, 34], iconAnchor: [13, 34], popupAnchor: [0, -30] });

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function haversineKm([la1, lo1], [la2, lo2]) {
  const r = (d) => (d * Math.PI) / 180, R = 6371;
  const a = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Calls FastAPI; falls back to labelled demo data if the endpoint is unavailable. */
async function fetchBanks([lat, lng]) {
  try {
    const url = `${API_BASE}${NEARBY_ENDPOINT}?lat=${lat}&lng=${lng}&radius_km=${SEARCH_RADIUS_KM}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return { banks: (await res.json()).blood_banks || [], demo: false };
  } catch {
    const offsets = [[0.012, 0.01, "City Central Blood Bank"], [-0.02, 0.015, "Lifeline Blood Centre"], [0.025, -0.02, "Red Cross Blood Bank"], [-0.03, -0.025, "Community Hospital Blood Bank"]];
    const banks = offsets.map(([dLat, dLng, name], i) => {
      const p = [lat + dLat, lng + dLng];
      return { id: `demo-${i}`, name, address: "Demo location", phone: "", lat: p[0], lng: p[1], distance_km: +haversineKm([lat, lng], p).toFixed(2) };
    });
    return { banks, demo: true };
  }
}

function render(banks, center, demo) {
  markers.clearLayers();
  const list = $("#bankList");
  if (!banks.length) {
    list.innerHTML = `<li class="bank-empty">No blood banks within ${SEARCH_RADIUS_KM} km. Try zooming out or searching again later.</li>`;
    return;
  }
  list.innerHTML = "";
  const bounds = L.latLngBounds([center]);
  banks.forEach((b) => {
    const eta = b.estimated_time_min ?? Math.round((b.distance_km / 35) * 60);
    L.marker([b.lat, b.lng], { icon: bloodIcon }).addTo(markers)
      .bindPopup(`<strong>${esc(b.name)}</strong><br>${esc(b.address)}<br>${b.distance_km} km`);
    bounds.extend([b.lat, b.lng]);
    const li = document.createElement("li");
    li.className = "bank";
    li.innerHTML = `
      <div><strong>${esc(b.name)}</strong><span class="muted">${esc(b.address || "")}</span>
      ${b.phone ? `<a class="link" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ""}</div>
      <div class="bank__dist"><b>${b.distance_km} km</b><span class="muted">~${eta} min</span></div>`;
    li.addEventListener("click", () => map.flyTo([b.lat, b.lng], 15));
    list.appendChild(li);
  });
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  if (demo) list.insertAdjacentHTML("afterbegin", `<li class="bank-empty">Demo data: the backend nearby endpoint isn't reachable yet.</li>`);
}

async function loadNearby(center) {
  $("#mapStatus").textContent = "Looking for blood banks…";
  if (youMarker) youMarker.setLatLng(center);
  else youMarker = L.circleMarker(center, { radius: 8, color: "#fff", weight: 3, fillColor: "#1565C0", fillOpacity: 1 }).addTo(map).bindPopup("You are here");
  const { banks, demo } = await fetchBanks(center);
  render(banks, center, demo);
  $("#mapStatus").textContent = `${banks.length} blood bank${banks.length === 1 ? "" : "s"} within ${SEARCH_RADIUS_KM} km.`;
}

const locateBtn = $("#locateBtn");
locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) { $("#mapStatus").textContent = "This browser can't share location."; return; }
  locateBtn.disabled = true;
  $("#mapStatus").textContent = "Waiting for your location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateBtn.disabled = false;
      locateBtn.textContent = "Refresh nearby blood banks";
      const c = [pos.coords.latitude, pos.coords.longitude];
      map.setView(c, 13);
      loadNearby(c);
    },
    () => {
      locateBtn.disabled = false;
      $("#mapStatus").textContent = "Location blocked. Allow location access in your browser and try again.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});
