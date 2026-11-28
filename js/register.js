// Yggdrasil registration: Firebase account (step 1) + FastAPI role profile (step 2).
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, updateProfile, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, API_BASE, ROLE_ROUTES, ROLE_LABELS } from "./firebase-config.js";

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const el = (tag, cls, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  n.append(...kids);
  return n;
};
const setBusy = (btn, on) => {
  btn.classList.toggle("is-loading", on);
  btn.disabled = on;
  btn.setAttribute("aria-busy", on ? "true" : "false");
};
const goTo = (url) => window.location.assign(url);

function showAlert(kind, message, items = []) {
  const box = $("#alert");
  box.replaceChildren();
  if (!message) return;
  const a = el("div", `alert alert--${kind}`, { role: kind === "error" ? "alert" : "status" }, message);
  if (items.length) a.append(el("ul", "", {}, ...items.map((t) => el("li", "", {}, t))));
  box.append(a);
}

/* -------------------------------------------------------------- role config */
const BG = ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"];
const F = (name, label, type = "text", o = {}) => ({ name, label, type, ...o });
const PHONE = F("phone", "Phone", "tel", { attrs: { pattern: "\\+?[0-9]{7,15}", title: "7 to 15 digits, e.g. +919876543210", placeholder: "+919876543210", autocomplete: "tel" } });
const EMAIL = F("email", "Email", "email", { prefill: "email", attrs: { autocomplete: "email", placeholder: "you@example.com" } });
const REGION = F("region", "City / region", "text", { attrs: { minlength: 2, maxlength: 80, placeholder: "Mysuru" } });
const COORDS = [
  F("lat", "Latitude", "number", { num: true, attrs: { step: "any", min: -90, max: 90, placeholder: "12.2958" } }),
  F("lng", "Longitude", "number", { num: true, attrs: { step: "any", min: -180, max: 180, placeholder: "76.6394" } }),
  F("geo", "", "geo"),
];

const ROLES = {
  donor: {
    hint: "Give blood and earn points", endpoint: "/donors/register", idKey: "yggdrasil.donor_id", getId: (d) => d.donor?.id,
    blurb: "Tell us a little about you so we can match you to emergencies nearby.",
    fields: [
      F("name", "Full name", "text", { prefill: "name", attrs: { minlength: 2, maxlength: 100, autocomplete: "name" } }),
      EMAIL, PHONE,
      F("age", "Age", "number", { num: true, attrs: { min: 18, max: 65, step: 1, placeholder: "18 to 65" } }),
      F("blood_group", "Blood group", "select", { options: BG }),
      REGION, ...COORDS,
      F("has_hiv_or_aids", "I have HIV or AIDS", "checkbox", {
        wide: true,
        note: "Health declaration: if this is checked, registration is rejected because you are not eligible to donate blood.",
      }),
    ],
  },
  blood_bank: {
    hint: "Run quests and camps", endpoint: "/blood-banks/register", idKey: "yggdrasil.bank_id", getId: (d) => d.blood_bank?.id,
    blurb: "Register your blood bank to post emergency quests and host donation camps.",
    fields: [
      F("name", "Blood bank name", "text", { attrs: { minlength: 2, maxlength: 150, placeholder: "City Central Blood Bank" } }),
      EMAIL, PHONE, REGION,
      F("address", "Address", "text", { wide: true, attrs: { minlength: 5, maxlength: 300, placeholder: "Street, city, PIN", autocomplete: "street-address" } }),
      ...COORDS,
      F("donor_mode", "Donor mode", "select", { options: [["public", "Public"], ["private", "Private"]] }),
      F("hosts_camps", "This bank hosts donation camps", "checkbox"),
    ],
  },
  requestor: {
    hint: "Request blood for patients", endpoint: "/requestors/register", idKey: "yggdrasil.requestor_id", getId: (d) => d.requestor?.id,
    blurb: "Register your facility to request blood from nearby blood banks.",
    fields: [
      F("facility_name", "Facility name", "text", { attrs: { minlength: 2, maxlength: 150, placeholder: "St. Mary's Hospital" } }),
      F("facility_type", "Facility type", "select", { options: [["hospital", "Hospital"], ["clinic", "Clinic"]] }),
      F("contact_person", "Contact person", "text", { prefill: "name", attrs: { minlength: 2, maxlength: 100, autocomplete: "name" } }),
      EMAIL, PHONE, REGION,
      F("address", "Address", "text", { wide: true, attrs: { minlength: 5, maxlength: 300, placeholder: "Street, city, PIN", autocomplete: "street-address" } }),
      ...COORDS,
    ],
  },
};
const ROLE_KEYS = Object.keys(ROLES);
const DEFAULT_LABELS = { donor: "Donor", blood_bank: "Blood bank", requestor: "Hospital / clinic" };
const roleLabel = (r) => ROLE_LABELS?.[r] ?? DEFAULT_LABELS[r];
const FIELD_LABELS = Object.fromEntries(
  ROLE_KEYS.flatMap((r) => ROLES[r].fields.filter((f) => f.label).map((f) => [f.name, f.label]))
);

/* ------------------------------------------------------------- build the UI */
function buildField(role, f) {
  if (f.type === "geo") {
    return el("div", "field span-2 geo", {},
      el("button", "btn btn--ghost btn--sm", { type: "button", "data-geo": true }, "Use current location"),
      el("span", "muted-inline", { "data-geo-status": true, role: "status" }));
  }
  const id = `${role}-${f.name}`;
  if (f.type === "checkbox") {
    const wrap = el("div", `field${f.wide ? " span-2" : ""}`);
    wrap.append(el("label", "check check--box", {}, el("input", "", { type: "checkbox", id, name: f.name }), f.label));
    if (f.note) wrap.append(el("p", "field__note", {}, f.note));
    return wrap;
  }
  let input;
  if (f.type === "select") {
    input = el("select", "", { id, name: f.name, required: true });
    input.append(el("option", "", { value: "" }, "Select…"));
    f.options.forEach((o) => {
      const [value, text] = Array.isArray(o) ? o : [o, o];
      input.append(el("option", "", { value }, text));
    });
  } else {
    input = el("input", "", { id, name: f.name, type: f.type, required: true, ...(f.attrs || {}) });
  }
  return el("div", `field${f.wide ? " span-2" : ""}`, {}, el("label", "", { for: id }, f.label), input);
}

function buildForms() {
  const host = $("#forms");
  for (const role of ROLE_KEYS) {
    const form = el("form", "reg__form", { id: `form-${role}`, "data-role": role, hidden: true });
    const grid = el("div", "form-grid");
    ROLES[role].fields.forEach((f) => grid.append(buildField(role, f)));
    form.append(grid, el("button", "btn btn--block", { type: "submit" },
      el("span", "btn__label", {}, `Register as ${roleLabel(role).toLowerCase()}`),
      el("span", "btn__spinner", { "aria-hidden": "true" })));
    form.addEventListener("submit", (e) => { e.preventDefault(); submitProfile(role, form); });
    host.append(form);
  }
}

function buildRoleSelector() {
  const box = $("#roleSelect");
  for (const role of ROLE_KEYS) {
    const input = el("input", "sr-only", { type: "radio", name: "role", value: role });
    input.addEventListener("change", () => setRole(role));
    box.append(el("label", "role", {}, input,
      el("span", "role__box", {}, el("b", "", {}, roleLabel(role)), el("small", "", {}, ROLES[role].hint))));
  }
}

/* -------------------------------------------------------------------- state */
let role = "donor";
let currentUser = null;
let signingUp = false;

function initialRole() {
  const q = new URLSearchParams(window.location.search).get("role");
  if (ROLES[q]) return q;
  const saved = ls.get("yggdrasil.role");
  return ROLES[saved] ? saved : "donor";
}

function setRole(next, updateUrl = true) {
  role = next;
  document.querySelectorAll('input[name="role"]').forEach((r) => { r.checked = r.value === role; });
  document.querySelectorAll(".reg__form[data-role]").forEach((f) => { f.hidden = f.dataset.role !== role; });
  $("#roleBlurb").textContent = ROLES[role].blurb;
  $("#h-step2").textContent = `${roleLabel(role)} profile`;
  document.title = `Register as ${roleLabel(role).toLowerCase()} · Yggdrasil`;
  showAlert();
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("role", role);
    history.replaceState(null, "", url);
  }
}

function showStep(n, scroll = false) {
  $("#authLoading").hidden = true;
  $("#done").hidden = true;
  $("#step1").hidden = n !== 1;
  $("#step2").hidden = n !== 2;
  $("#stepDot1").className = n === 1 ? "is-current" : "is-done";
  $("#stepDot2").className = n === 2 ? "is-current" : "";
  [1, 2].forEach((i) => {
    if (n === i) $(`#stepDot${i}`).setAttribute("aria-current", "step");
    else $(`#stepDot${i}`).removeAttribute("aria-current");
  });
  if (scroll && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    $(".reg__card").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function enterProfileStep(user, nameHint, scroll = false) {
  currentUser = user;
  const name = nameHint || user.displayName || "";
  document.querySelectorAll(".reg__form[data-role]").forEach((form) => {
    for (const [role_, cfg] of Object.entries(ROLES)) {
      if (form.dataset.role !== role_) continue;
      cfg.fields.filter((f) => f.prefill).forEach((f) => {
        const input = form.elements[f.name];
        if (f.prefill === "email" && user.email) { input.value = user.email; input.readOnly = true; }
        if (f.prefill === "name" && name && !input.value) input.value = name;
      });
    }
  });
  $("#signedEmail").textContent = user.email || user.displayName || "your account";
  $("#signedIn").hidden = false;
  showAlert();
  showStep(2, scroll);
}

/* ------------------------------------------------------------ Firebase auth */
const AUTH_ERRORS = {
  "auth/email-already-in-use": "An account with this email already exists. If you signed up with Google, use Continue with Google instead.",
  "auth/weak-password": "That password is too weak. Use at least 6 characters.",
  "auth/invalid-email": "That email address does not look right. Check it and try again.",
  "auth/popup-closed-by-user": "The Google window was closed before sign-in finished. Try again when you are ready.",
  "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
  "auth/network-request-failed": "Could not reach Firebase. Check your internet connection and try again.",
  "auth/unauthorized-domain": "This website's domain is not authorised in Firebase. Add it under Authentication > Settings > Authorized domains.",
  "auth/operation-not-allowed": "This sign-in method is not turned on in Firebase. Enable it under Authentication > Sign-in method.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
};
function authError(err) {
  if (err?.code === "auth/cancelled-popup-request") return; // a second click replaced the first popup
  showAlert("error", AUTH_ERRORS[err?.code] || `Sign-in failed (${err?.code || "unknown error"}). Please try again.`);
}

let auth = null;
try {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
} catch (err) {
  console.error(err);
}

function wireAuth() {
  if (!auth) {
    showStep(1);
    showAlert("error", "Firebase could not start. Check firebaseConfig in js/firebase-config.js.");
    return;
  }

  onAuthStateChanged(auth, (user) => {
    if (signingUp) return; // the email sign-up flow advances itself once the name is saved
    if (user) enterProfileStep(user);
    else { currentUser = null; showStep(1); }
  });

  $("#googleBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    showAlert();
    setBusy(btn, true);
    try {
      const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
      enterProfileStep(user, user.displayName, true);
    } catch (err) { authError(err); }
    finally { setBusy(btn, false); }
  });

  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type="submit"]');
    const name = form.elements.name.value.trim();
    showAlert();
    setBusy(btn, true);
    signingUp = true;
    try {
      const { user } = await createUserWithEmailAndPassword(auth, form.elements.email.value.trim(), form.elements.password.value);
      try { await updateProfile(user, { displayName: name }); } catch (err) { console.warn("Could not save display name", err); }
      signingUp = false;
      enterProfileStep(user, name, true);
      form.reset();
    } catch (err) {
      signingUp = false;
      authError(err);
    } finally { setBusy(btn, false); }
  });

  $("#signOutBtn").addEventListener("click", async () => {
    try { await signOut(auth); } catch (err) { console.warn(err); }
    document.querySelectorAll(".reg__form[data-role]").forEach((f) => {
      f.reset();
      f.querySelectorAll("input[readonly]").forEach((i) => { i.readOnly = false; });
    });
    $("#signedIn").hidden = true;
    currentUser = null;
    showAlert("info", "You have signed out.");
    showStep(1);
  });
}

/* ---------------------------------------------------------------- geolocation */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-geo]");
  if (!btn) return;
  const form = btn.closest("form");
  const status = form.querySelector("[data-geo-status]");
  if (!navigator.geolocation) { status.textContent = "Your browser does not support location."; return; }
  status.textContent = "Finding your location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      form.elements.lat.value = pos.coords.latitude.toFixed(6);
      form.elements.lng.value = pos.coords.longitude.toFixed(6);
      status.textContent = "Location added.";
    },
    (err) => {
      status.textContent = err.code === 1
        ? "Location is blocked. Allow it in your browser, or type the coordinates."
        : "Could not get your location. Type the coordinates instead.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

/* ------------------------------------------------------------ FastAPI submit */
const FIELD_KEYS = (r) => ROLES[r].fields.filter((f) => f.type !== "geo");

function collect(form, r) {
  const out = {};
  for (const f of FIELD_KEYS(r)) {
    const input = form.elements[f.name];
    if (f.type === "checkbox") out[f.name] = input.checked;
    else if (f.num) out[f.name] = Number(input.value);
    else out[f.name] = input.value.trim();
  }
  return out;
}

function apiError(status, data) {
  const d = data?.detail;
  if (Array.isArray(d)) {
    const items = d.map((e) => {
      const key = [...(e.loc || [])].reverse().find((p) => typeof p === "string");
      const msg = String(e.msg || "is invalid").replace(/^Value error, /, "");
      return `${FIELD_LABELS[key] || key || "Field"}: ${msg}`;
    });
    return ["Please fix the following and try again:", items];
  }
  if (typeof d === "string") {
    if (status === 409) return [`${d}. Use a different email or phone number.`, []];
    return [d, []];
  }
  if (status === 404) return ["This registration service was not found on the server.", []];
  if (status >= 500) return ["The server had a problem. Please try again in a moment.", []];
  return [`Registration failed (error ${status}).`, []];
}

async function submitProfile(r, form) {
  if (!form.reportValidity()) return;
  const btn = form.querySelector('button[type="submit"]');
  showAlert();
  setBusy(btn, true);
  try {
    let res;
    try {
      res = await fetch(`${String(API_BASE).replace(/\/+$/, "")}${ROLES[r].endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect(form, r)),
      });
    } catch {
      showAlert("error", "Could not reach the Yggdrasil server. Check your connection and try again.");
      return;
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const [msg, items] = apiError(res.status, data);
      showAlert("error", msg, items);
      return;
    }
    onRegistered(r, data || {});
  } finally { setBusy(btn, false); }
}

function onRegistered(r, data) {
  const id = ROLES[r].getId(data);
  if (id) ls.set(ROLES[r].idKey, id);
  ls.set("yggdrasil.role", r);

  const href = ROLE_ROUTES?.[r] || "index.html";
  const donor = data.donor || {};
  const shiny = r === "donor" && (data.is_rare_shiny ?? donor.is_rare_shiny) === true;

  showAlert();
  $("#step1").hidden = $("#step2").hidden = true;
  $("#stepDot1").className = $("#stepDot2").className = "is-done";
  $("#shinyBadge").hidden = !shiny;
  if (shiny) {
    $("#shinyGroup").textContent = `Rare blood group ${donor.blood_group || ""}`.trim();
    $("#shinyMult").textContent = `${donor.points_multiplier || 5}x Points Multiplier!`;
  }
  $("#doneTitle").textContent = shiny ? "You are a Shiny donor!" : "You are registered";
  $("#doneMsg").textContent = data.message || "Taking you to your dashboard…";
  $("#doneBtn").href = href;
  $("#done").hidden = false;
  $(".reg__card").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => goTo(href), shiny ? 5000 : 1500);
}

/* --------------------------------------------------------------------- start */
$("#year").textContent = new Date().getFullYear();
buildRoleSelector();
buildForms();
setRole(initialRole(), false);
wireAuth();
