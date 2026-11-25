/**
 * Yggdrasil blood bank portal logic:
 *   0. Helpers (DOM, storage, API, alerts)
 *   1. Profile banner + sidebar tabs
 *   2. Registration            POST /blood-banks/register
 *   3. Private donors          POST /blood-banks/{id}/private-donors
 *   4. Emergency quests        POST/GET /blood-banks/{id}/emergency-quests[/{quest_id}] + POST /blood-banks/feedback
 *   5. Camps                   POST /blood-banks/{id}/camps
 *   6. Dual-QR scanner         POST /blood-banks/qr-scan
 *   7. Hospital requests       GET/PATCH /blood-banks/{id}/hospital-requests[/{request_id}]
 *   8. Dashboard + start-up
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, API_BASE } from "./firebase-config.js";

/* ───────────── 0. Helpers ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => { if (!d) return "—"; const t = new Date(d); return isNaN(t) ? esc(d) : t.toLocaleString(); };
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const val = (f, n) => (f.elements[n]?.value ?? "").trim();
const numOrUndef = (f, n) => (val(f, n) === "" ? undefined : Number(val(f, n)));

const KEYS = { bank: "yggdrasil.bank_id", name: "yggdrasil.bank_name", coords: "yggdrasil.bank_coords", side: "yggdrasil.sidebar" };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
const bankId = () => store.get(KEYS.bank) || "";

/** Per-bank lists kept in this browser (the backend has no list endpoints for these). */
const localKey = () => `yggdrasil.bank.${bankId()}`;
function local() {
  const empty = { donors: [], quests: [], camps: [] };
  try { return { ...empty, ...JSON.parse(store.get(localKey()) || "{}") }; } catch { return empty; }
}
function remember(kind, item, keyField = "id", max = 20) {
  const d = local();
  d[kind] = [item, ...d[kind].filter((x) => x[keyField] !== item[keyField])].slice(0, max);
  store.set(localKey(), JSON.stringify(d));
}

const configured = !firebaseConfig.apiKey.startsWith("YOUR_");
const auth = configured ? getAuth(initializeApp(firebaseConfig)) : null;

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

/** FastAPI sends `detail` as a string (400/404/409) or a list (422). */
function detailText(d) {
  if (!d) return null;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => { const where = (e.loc || []).filter((x) => x !== "body").join("."); return where ? `${where}: ${e.msg}` : e.msg; }).join("; ");
  return JSON.stringify(d);
}
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach the backend at ${API_BASE}. Is uvicorn running, and is CORS enabled?`, 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(detailText(data?.detail) || `Request failed (${res.status}).`, res.status);
  return data;
}

const ALERT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
function initAlerts() {
  $$("[data-alert]").forEach((el) => { el.className = "alert"; el.setAttribute("role", "alert"); el.hidden = true; el.innerHTML = `${ALERT_ICON}<span></span>`; });
}
function showAlert(key, msg, type = "error") {
  const el = $(`[data-alert="${key}"]`);
  if (!el) return;
  if (!msg) { el.hidden = true; return; }
  el.classList.toggle("alert--ok", type === "ok");
  $("span", el).textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function setBusy(btn, on) { if (!btn) return; btn.classList.toggle("is-loading", on); btn.disabled = on; }

function requireBank() {
  const id = bankId();
  if (!id) throw new Error("Load or register a blood bank first (see the banner at the top).");
  return id;
}

/** Wire a form: clears the alert, shows the spinner, and reports API errors in the alert banner. */
function bindForm(selector, alertKey, handler, { needsBank = true } = {}) {
  const form = $(selector);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAlert(alertKey, "");
    const btn = $('[type="submit"]', form);
    setBusy(btn, true);
    try { await handler(form, needsBank ? requireBank() : null); }
    catch (err) { showAlert(alertKey, err.message); }
    finally { setBusy(btn, false); }
  });
}

const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const copyBtn = (text) => `<button class="copy" type="button" data-copy="${esc(text)}">Copy</button>`;
const stars = (n) => `<span class="stars" aria-label="${n} out of 5">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
$("#year").textContent = new Date().getFullYear();

/* ───────────── 1. Profile banner + tabs ───────────── */
const panels = $$(".panel");
let autoTimer = 0;

function setBadge() {
  const id = bankId();
  const name = id ? store.get(KEYS.name) || "Blood bank" : "";
  document.body.classList.toggle("has-bank", !!id);
  $("#bankBadge").hidden = !id;
  $("#bankBadgeName").textContent = name;
  $("#bankBadgeId").textContent = id.length > 10 ? `${id.slice(0, 8)}…` : id;
  $("#bankBadge").title = id ? `Bank ID: ${id}` : "";
  $("#bankStatus").textContent = id ? `Active profile: ${name} · ID ${id}` : "No blood bank loaded. Register a new one or paste an existing bank_id.";
  $("#bankIdInput").value = id;
}

function jumpToWorkspace() {
  // smooth-scroll.js handles clicks on in-page links, so click a hidden one.
  if ($("#workspace").getBoundingClientRect().top < 0) $("#jumpWorkspace").click();
}

function showTab(name, { scroll = true } = {}) {
  panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $$(".side__btn").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  if (name !== "quests") stopAuto();
  if (name === "dashboard") renderDashboard();
  if (name === "quests") fillQuestList();
  if (name === "scanner") fillTargetList();
  if (name === "requests" && bankId()) loadRequests();
  if (scroll) jumpToWorkspace();
}

/** Switching profiles: validate the id (the backend has no "get bank" route, so ask for its requests). */
async function loadBank(id) {
  id = id.trim();
  if (!id) throw new Error("Paste a bank_id first.");
  await api(`/blood-banks/${encodeURIComponent(id)}/hospital-requests`); // 404 if the bank does not exist
  if (id !== bankId()) { store.del(KEYS.name); store.del(KEYS.coords); resetViews(); }
  store.set(KEYS.bank, id);
  setBadge();
  renderPrivateList(); renderCampList(); fillQuestList(); fillTargetList(); renderDashboard();
}

function resetViews() {
  ["#privateResult", "#questResult", "#trackerOut", "#campResult", "#reqList", "#feedbackView"].forEach((s) => { $(s).innerHTML = ""; });
  $("#feedbackBox").hidden = true;
  $("#trackId").value = "";
  state.quest = null;
  stopAuto();
}

const state = { quest: null, scans: [] };

$("#bankLoadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("banner", "");
  const btn = $('[type="submit"]', e.currentTarget);
  setBusy(btn, true);
  try {
    await loadBank($("#bankIdInput").value);
    showAlert("banner", "Blood bank loaded.", "ok");
    showTab("dashboard");
  } catch (err) { showAlert("banner", err.message); }
  finally { setBusy(btn, false); }
});

$("#forgetBtn").addEventListener("click", () => {
  Object.values(KEYS).filter((k) => k !== KEYS.side).forEach(store.del);
  resetViews(); setBadge(); renderPrivateList(); renderCampList(); renderDashboard();
  showAlert("banner", "Profile cleared from this browser.", "ok");
});

$("#signOutBtn").addEventListener("click", async () => {
  try { if (auth) await signOut(auth); } catch { /* ignore, still leave */ }
  location.href = "index.html";
});

/* Sidebar: collapsed icon rail by default, expandable, choice remembered */
const side = $("#side");
function setSide(open) {
  side.classList.toggle("is-open", open);
  const t = $("#sideToggle");
  t.setAttribute("aria-expanded", String(open));
  t.setAttribute("aria-label", open ? "Collapse menu" : "Expand menu");
  store.set(KEYS.side, open ? "1" : "0");
}
$("#sideToggle").addEventListener("click", () => setSide(!side.classList.contains("is-open")));
$$(".side__btn").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* Delegated clicks: goto buttons, copy buttons, track/scan shortcuts */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) { showTab(go.dataset.goto); return; }
  if (e.target.closest("[data-action='focus-bank']")) { $("#bankIdInput").focus(); $("#profile-banner").scrollIntoView({ behavior: "smooth" }); return; }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    navigator.clipboard?.writeText(cp.dataset.copy).then(() => { cp.textContent = "Copied"; setTimeout(() => { cp.textContent = "Copy"; }, 1400); }).catch(() => {});
    return;
  }
  const tr = e.target.closest("[data-track]");
  if (tr) { showTab("quests"); $("#trackId").value = tr.dataset.track; $("#trackForm").requestSubmit(); return; }
  const sc = e.target.closest("[data-scan-donor]");
  if (sc) { prefillScan({ donor_id: sc.dataset.scanDonor, type: "quest", target: state.quest?.id || "" }); return; }
  const sct = e.target.closest("[data-scan-target]");
  if (sct) prefillScan({ type: sct.dataset.scanType, target: sct.dataset.scanTarget });
});

/* ───────────── 2. Registration ───────────── */
$("#geoBtn").addEventListener("click", () => {
  const status = $("#geoStatus");
  if (!navigator.geolocation) { status.textContent = "This browser can't share location."; return; }
  status.textContent = "Waiting for your location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("#r-lat").value = pos.coords.latitude.toFixed(6);
      $("#r-lng").value = pos.coords.longitude.toFixed(6);
      status.textContent = "Location filled in.";
    },
    () => { status.textContent = "Location blocked. Allow access in your browser, or type the coordinates."; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

bindForm("#registerForm", "register", async (f) => {
  const body = {
    name: val(f, "name"), email: val(f, "email"), phone: val(f, "phone").replace(/[\s-]/g, ""),
    address: val(f, "address"), region: val(f, "region"),
    lat: Number(val(f, "lat")), lng: Number(val(f, "lng")),
    hosts_camps: f.elements.hosts_camps.checked, donor_mode: val(f, "donor_mode"),
  };
  const r = await api("/blood-banks/register", { method: "POST", body });
  const bank = r.blood_bank;
  resetViews();
  store.set(KEYS.bank, bank.id);
  store.set(KEYS.name, bank.name || body.name);
  store.set(KEYS.coords, JSON.stringify([body.lat, body.lng]));
  f.reset();
  await loadBank(bank.id);
  showTab("dashboard");
  showAlert("banner", `${r.message} Your bank_id is ${bank.id}.`, "ok");
}, { needsBank: false });

/* ───────────── 3. Private donors ───────────── */
function renderPrivateList() {
  const donors = bankId() ? local().donors : [];
  $("#privateCount").textContent = donors.length;
  $("#privateList").innerHTML = donors.length
    ? donors.map((d) => `<li class="item"><div><strong>${esc(d.name)}</strong><span class="muted">${esc(d.phone)}${d.blood_group ? ` · ${esc(d.blood_group)}` : ""}</span></div>
        <span class="chip ${d.is_app_user ? "chip--ok" : "chip--warn"}">${d.is_app_user ? "In-app user" : "SMS only"}</span></li>`).join("")
    : '<li class="bank-empty">No private donors saved yet.</li>';
}

bindForm("#privateForm", "private", async (f, id) => {
  const body = compact({ name: val(f, "name"), phone: val(f, "phone").replace(/[\s-]/g, ""), email: val(f, "email"), blood_group: val(f, "blood_group") });
  const r = await api(`/blood-banks/${id}/private-donors`, { method: "POST", body });
  const n = r.notification || {};
  const isApp = n.channel === "app";
  const d = r.private_donor;
  $("#privateResult").innerHTML = `<div class="result">
    <div class="result__head"><span class="chip ${isApp ? "chip--ok" : "chip--warn"}">${isApp ? "In-App User" : "SMS Fallback"}</span><strong>${esc(d.name)}</strong></div>
    <p>${isApp ? "Matched an existing Yggdrasil donor. An in-app notification was queued." : "Not an app user, so an SMS was queued instead."}</p>
    ${kv([
      ["Channel", esc(n.channel)],
      ["Phone", esc(d.phone)],
      ["Blood group", esc(d.blood_group)],
      ["Linked donor ID", d.donor_id ? `<code>${esc(d.donor_id)}</code>` : ""],
      ["Notification ID", n.notification_id ? `<code>${esc(n.notification_id)}</code>` : ""],
      ["SMS status", n.status ? esc(n.status) : ""],
      ["SMS provider", n.provider ? esc(n.provider) : ""],
    ])}
    ${n.provider === "placeholder" ? '<p class="muted">The SMS sender is still a placeholder on the server (it only logs the message).</p>' : ""}</div>`;
  remember("donors", d, "phone", 200);
  renderPrivateList();
  f.reset();
  showAlert("private", r.message, "ok");
});

/* ───────────── 4. Emergency quests + tracker + feedback ───────────── */
const STATE_LABEL = {
  accepted: ["Accepted · awaiting Scan 1", "info"],
  registered: ["Registered · awaiting Scan 1", "info"],
  checked_in: ["Checked in · awaiting Scan 2", "warn"],
  completed: ["Donation completed", "ok"],
};

function fillQuestList() {
  $("#questIds").innerHTML = (bankId() ? local().quests : []).map((q) => `<option value="${esc(q.id)}">${esc(q.blood_group)} · ${esc(q.units)} unit(s)</option>`).join("");
}

bindForm("#questForm", "quests", async (f, id) => {
  const body = compact({
    blood_group_needed: val(f, "blood_group_needed"),
    units_required: Number(val(f, "units_required")),
    search_radius_km: Number(val(f, "search_radius_km")),
    notes: val(f, "notes"),
  });
  const r = await api(`/blood-banks/${id}/emergency-quests`, { method: "POST", body });
  const q = r.quest;
  remember("quests", { id: q.id, blood_group: q.blood_group_needed, units: q.units_required });
  fillQuestList();
  $("#questResult").innerHTML = `<div class="result">
    <div class="result__head"><span class="chip chip--warn">${esc(q.status || "open")}</span><strong>${esc(q.blood_group_needed)} · ${esc(q.units_required)} unit(s)</strong></div>
    <div class="big">${esc(r.notified_donors_count)}</div><p>nearby donor(s) notified</p>
    ${kv([["Quest ID", `<code>${esc(q.id)}</code>${copyBtn(q.id)}`], ["Radius", `${esc(q.search_radius_km)} km`], ["Region", esc(q.region)]])}
    <div class="btn-row"><button class="btn btn--sm" type="button" data-track="${esc(q.id)}">Track this quest</button></div></div>`;
  showAlert("quests", r.message, "ok");
});

async function trackQuest(qid, { silent = false } = {}) {
  const id = requireBank();
  qid = qid.trim();
  if (!qid) throw new Error("Enter a quest_id to track.");
  const data = await api(`/blood-banks/${id}/emergency-quests/${encodeURIComponent(qid)}`);
  state.quest = { id: qid, data };
  renderTracker(qid, data);
  if (!silent) showAlert("tracker", "");
}

$("#trackForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("tracker", "");
  const btn = $('[type="submit"]', e.currentTarget);
  setBusy(btn, true);
  try { await trackQuest($("#trackId").value); }
  catch (err) { showAlert("tracker", err.message); stopAuto(); }
  finally { setBusy(btn, false); }
});

function stopAuto() { clearInterval(autoTimer); autoTimer = 0; $("#autoRefresh").checked = false; }
$("#autoRefresh").addEventListener("change", (e) => {
  clearInterval(autoTimer);
  if (!e.target.checked) return;
  autoTimer = setInterval(() => { if (state.quest) trackQuest(state.quest.id, { silent: true }).catch((err) => { showAlert("tracker", err.message); stopAuto(); }); }, 15000);
});

function feedbackItems(list, names) {
  if (!list?.length) return '<p class="bank-empty">Nothing yet.</p>';
  return list.map((f) => `<div class="fb">${stars(f.rating || 0)}
    ${f.about_donor_id ? `<span class="muted">About ${esc(names.get(f.about_donor_id) || f.about_donor_id)}</span>` : ""}
    ${f.comment ? `<p>${esc(f.comment)}</p>` : ""}</div>`).join("");
}

function renderTracker(qid, q) {
  const need = q.units_required || 0, got = q.accepted_donors_count || 0;
  const pct = need ? Math.min(100, Math.round((got / need) * 100)) : 0;
  const done = q.criteria_fulfilled || q.status === "criteria_fulfilled";
  const checkins = new Map((q.checkins || []).map((c) => [c.donor_id, c]));
  const donors = q.accepted_donors || [];
  const names = new Map(donors.map((d) => [d.id, d.name]));

  $("#trackerOut").innerHTML = `
    <div class="tracker__top">
      <span class="chip ${done ? "chip--ok" : "chip--warn"}">${esc(q.status)}</span>
      <strong>${esc(q.blood_group_needed)} · ${esc(need)} unit(s)</strong>
    </div>
    <p style="margin:12px 0 0"><b>${esc(got)} / ${esc(need)}</b> donors accepted</p>
    <div class="meter ${done ? "meter--done" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    ${kv([["Quest ID", `<code>${esc(qid)}</code>${copyBtn(qid)}`], ["Created", fmt(q.created_at)], ["Fulfilled", q.fulfilled_at ? fmt(q.fulfilled_at) : ""]])}
    <h4>Accepted donors</h4>
    <ul class="list">${donors.length ? donors.map((d) => {
      const c = checkins.get(d.id);
      const st = c?.state || "accepted";
      const [label, tone] = STATE_LABEL[st] || [st, "info"];
      return `<li class="item"><div><strong>${esc(d.name || "Donor")}</strong>
        <span class="muted">${esc(d.blood_group || "")} · <code>${esc(d.id)}</code></span>
        ${c?.blood_bag_id ? `<span class="muted">Bag ${esc(c.blood_bag_id)}</span>` : ""}</div>
        <div class="item__side"><span class="chip chip--${tone}">${esc(label)}</span>
        ${st !== "completed" ? `<button class="btn btn--ghost btn--sm" type="button" data-scan-donor="${esc(d.id)}">Scan</button>` : ""}</div></li>`;
    }).join("") : '<li class="bank-empty">No donor has accepted yet.</li>'}</ul>`;

  // Feedback viewer + form
  $("#feedbackBox").hidden = false;
  $("#feedbackView").innerHTML = `<h4 style="margin-top:0">From your blood bank</h4>${feedbackItems(q.feedback?.from_blood_bank, names)}
    <h4>From donors</h4>${feedbackItems(q.feedback?.from_donors, names)}`;
  const rank = (d) => (checkins.get(d.id)?.state === "completed" ? 0 : 1);
  const sel = $("#fb-donor");
  const prev = sel.value;
  sel.innerHTML = [...donors].sort((a, b) => rank(a) - rank(b)).map((d) => {
    const st = checkins.get(d.id)?.state || "accepted";
    return `<option value="${esc(d.id)}">${esc(d.name || d.id)} (${esc(st)})</option>`;
  }).join("") || '<option value="">No accepted donors yet</option>';
  if (prev && donors.some((d) => d.id === prev)) sel.value = prev;
}

bindForm("#feedbackForm", "feedback", async (f, id) => {
  if (!state.quest) throw new Error("Track a quest first.");
  if (!val(f, "donor_id")) throw new Error("Choose a donor to rate.");
  const body = compact({
    target_type: "quest", target_id: state.quest.id, from_role: "blood_bank", from_id: id,
    donor_id: val(f, "donor_id"), rating: Number(val(f, "rating")), comment: val(f, "comment"),
  });
  const r = await api("/blood-banks/feedback", { method: "POST", body });
  f.elements.comment.value = "";
  await trackQuest(state.quest.id, { silent: true });
  showAlert("feedback", r.message, "ok");
});

/* ───────────── 5. Camps ───────────── */
function renderCampList() {
  const camps = bankId() ? local().camps : [];
  $("#campCount").textContent = camps.length;
  $("#campList").innerHTML = camps.length
    ? camps.map((c) => `<li class="item"><div><strong>${esc(c.title)}</strong><span class="muted">${fmt(c.start_time)}</span><code>${esc(c.id)}</code></div>
        <button class="btn btn--ghost btn--sm" type="button" data-scan-type="camp" data-scan-target="${esc(c.id)}">Check in</button></li>`).join("")
    : '<li class="bank-empty">No camps created yet.</li>';
}

bindForm("#campForm", "camps", async (f, id) => {
  const start = new Date(val(f, "start_time")), end = new Date(val(f, "end_time"));
  if (isNaN(start) || isNaN(end)) throw new Error("Choose both a start and an end time.");
  if (end <= start) throw new Error("End time must be after the start time.");
  const body = compact({
    title: val(f, "title"), description: val(f, "description"), venue: val(f, "venue"),
    start_time: start.toISOString(), end_time: end.toISOString(),
    capacity: numOrUndef(f, "capacity"), community_service_points: Number(val(f, "community_service_points")),
  });
  const r = await api(`/blood-banks/${id}/camps`, { method: "POST", body });
  const c = r.camp;
  remember("camps", { id: c.id, title: c.title, start_time: c.start_time });
  renderCampList();
  $("#campResult").innerHTML = `<div class="result">
    <div class="result__head"><span class="chip chip--ok">Camp created</span><strong>${esc(c.title)}</strong></div>
    <div class="big">${esc(r.notified_donors_count)}</div><p>nearby donor(s) notified</p>
    ${kv([
      ["Camp ID", `<code>${esc(c.id)}</code>${copyBtn(c.id)}`],
      ["QR token", c.qr_token ? `<code>${esc(c.qr_token)}</code>${copyBtn(c.qr_token)}` : ""],
      ["Venue", esc(c.venue)], ["Starts", fmt(c.start_time)], ["Ends", fmt(c.end_time)],
      ["Capacity", c.capacity ?? "Unlimited"], ["Points", esc(c.community_service_points)],
    ])}
    <div class="btn-row"><button class="btn btn--sm" type="button" data-scan-type="camp" data-scan-target="${esc(c.id)}">Open check-in</button></div></div>`;
  f.reset();
  f.elements.community_service_points.value = 50;
  showAlert("camps", r.message, "ok");
});

/* ───────────── 6. Dual-QR scanner ───────────── */
function fillTargetList() {
  const type = $("#s-type").value;
  const items = bankId() ? local()[type === "camp" ? "camps" : "quests"] : [];
  $("#targetIds").innerHTML = items.map((i) => `<option value="${esc(i.id)}">${esc(i.title || `${i.blood_group} · ${i.units} unit(s)`)}</option>`).join("");
  $("#s-target-label").textContent = type === "camp" ? "Camp ID" : "Quest ID";
  $("#s-target").placeholder = type === "camp" ? "camp_id" : "quest_id";
}
$("#s-type").addEventListener("change", fillTargetList);

function prefillScan({ donor_id, type, target }) {
  showTab("scanner");
  if (type) $("#s-type").value = type;
  fillTargetList();
  if (donor_id !== undefined) $("#s-donor").value = donor_id;
  if (target !== undefined) $("#s-target").value = target;
  $("#s-bag").value = "";
  $(donor_id ? "#s-bag" : "#s-donor").focus({ preventScroll: true });
}

function renderSteps(status) {
  const [s1, s2] = $$("#scanSteps .step");
  s1.classList.toggle("is-done", status === "checked_in" || status === "completed");
  s2.classList.toggle("is-done", status === "completed");
}

bindForm("#scanForm", "scanner", async (f, id) => {
  const body = compact({
    bank_id: id, donor_id: val(f, "donor_id"), target_id: val(f, "target_id"),
    target_type: val(f, "target_type"), blood_bag_id: val(f, "blood_bag_id"),
  });
  const r = await api("/blood-banks/qr-scan", { method: "POST", body });
  renderSteps(r.status);
  if (r.status === "completed") {
    const shiny = (r.points_multiplier || 1) > 1;
    $("#scanResult").innerHTML = `<div class="result">
      <div class="result__head"><span class="chip chip--ok">Scan 2 · completed</span></div>
      <p>${esc(r.message)}</p>
      <div class="tiles">
        <div class="tile"><small>Blood bag ID</small><strong>${esc(r.blood_bag_id)}</strong></div>
        <div class="tile"><small>Base points</small><strong>${esc(r.base_points)}</strong></div>
        <div class="tile"><small>Multiplier</small><strong>${esc(r.points_multiplier)}×${shiny ? ' <span class="shiny">Shiny</span>' : ""}</strong></div>
        <div class="tile"><small>Points awarded</small><strong>${esc(r.points_awarded)}</strong></div>
        <div class="tile"><small>New total points</small><strong>${esc(r.new_total_points)}</strong></div>
      </div>
      ${kv([["Completed", fmt(r.completed_timestamp)]])}</div>`;
    f.elements.blood_bag_id.value = "";
  } else {
    $("#scanResult").innerHTML = `<div class="result">
      <div class="result__head"><span class="chip chip--warn">Scan 1 · checked_in</span></div>
      <p>${esc(r.message)}</p>
      ${kv([["Checked in", fmt(r.check_in_timestamp)]])}
      <p class="muted">Next: scan again with a blood bag ID once the donation is done.</p></div>`;
  }
  state.scans.unshift({ donor: body.donor_id, status: r.status, at: new Date() });
  state.scans = state.scans.slice(0, 8);
  $("#scanHistory").innerHTML = state.scans.map((s) => `<li class="item"><div><strong>${esc(s.donor)}</strong><span class="muted">${s.at.toLocaleTimeString()}</span></div>
    <span class="chip ${s.status === "completed" ? "chip--ok" : "chip--warn"}">${s.status === "completed" ? "Scan 2" : "Scan 1"}</span></li>`).join("");
  showAlert("scanner", r.message, "ok");
});

/* ───────────── 7. Hospital requests ───────────── */
const REQ_STATUS = {
  open: ["Open", "warn"],
  criteria_fulfilled: ["Accepted", "ok"],
  rejected_blood_na: ["Rejected · blood N/A", "err"],
  rejected_service_na: ["Rejected · service N/A", "err"],
};
const maps = new Map();

function bankCoords() { try { return JSON.parse(store.get(KEYS.coords) || "null"); } catch { return null; } }

function requestCard(r) {
  const rq = r.requestor || {};
  const [label, tone] = REQ_STATUS[r.status] || [r.status, "info"];
  const mode = r.delivery_mode || r.fulfilment_mode || "—";
  const hasPos = rq.lat != null && rq.lng != null;
  const dist = r.distance_km ?? r.estimated_distance_km;
  return `<article class="req" data-id="${esc(r.id)}" data-lat="${hasPos ? rq.lat : ""}" data-lng="${hasPos ? rq.lng : ""}" data-name="${esc(rq.facility_name || "Hospital")}">
    <div class="req__head">
      <div><h3>${esc(rq.facility_name || "Unknown facility")}</h3>
        <span class="muted">${esc(rq.facility_type || "")}${rq.facility_type && rq.address ? " · " : ""}${esc(rq.address || "")}</span></div>
      <div class="item__side"><span class="chip chip--${tone}">${esc(label)}</span><span class="req__group">${esc(r.blood_group_needed)}</span></div>
    </div>
    <div class="req__body">
      <div><small>Contact</small><strong>${esc(rq.contact_person || "—")}</strong></div>
      <div><small>Phone</small><strong>${rq.phone ? `<a class="link" href="tel:${esc(rq.phone)}">${esc(rq.phone)}</a>` : "—"}</strong></div>
      <div><small>Units</small><strong>${esc(r.units_required)}</strong></div>
      <div><small>Mode</small><strong>${esc(mode)}</strong></div>
      <div><small>Distance</small><strong>${dist != null ? `${esc(dist)} km` : "—"}</strong></div>
      <div><small>ETA</small><strong>${r.estimated_time_min != null ? `~${esc(r.estimated_time_min)} min` : "—"}</strong></div>
      <div><small>Requested</small><strong>${fmt(r.created_at)}</strong></div>
      ${r.notes ? `<div class="span-2"><small>Notes</small><strong>${esc(r.notes)}</strong></div>` : ""}
      ${r.rejection_reason ? `<div class="span-2"><small>Rejection reason</small><strong>${esc(r.rejection_reason)}</strong></div>` : ""}
    </div>
    <div class="req__actions">
      ${hasPos ? '<button class="btn btn--ghost btn--sm" type="button" data-map>View on map</button>' : '<span class="muted">No coordinates on file</span>'}
      ${r.status === "open" ? `
        <button class="btn btn--sm" type="button" data-act="accepted">Accept</button>
        <input class="reason" type="text" maxlength="300" placeholder="Rejection reason (optional)" aria-label="Rejection reason" />
        <button class="btn btn--danger btn--sm" type="button" data-act="rejected_blood_na">Reject (Blood N/A)</button>
        <button class="btn btn--danger btn--sm" type="button" data-act="rejected_service_na">Reject (Service N/A)</button>` : ""}
    </div>
    <div class="mini-map" hidden></div>
  </article>`;
}

async function loadRequests() {
  const id = requireBank();
  const status = $("#reqFilter").value;
  $("#reqStatus").textContent = "Loading…";
  try {
    const r = await api(`/blood-banks/${id}/hospital-requests${status ? `?status=${status}` : ""}`);
    maps.forEach((m) => m.remove()); maps.clear();
    $("#reqList").innerHTML = r.requests.length ? r.requests.map(requestCard).join("") : '<p class="bank-empty">No requests match this filter.</p>';
    $("#reqStatus").textContent = `${r.count} request${r.count === 1 ? "" : "s"}.`;
  } catch (err) {
    $("#reqStatus").textContent = "";
    throw err;
  }
}

$("#reqRefresh").addEventListener("click", async (e) => {
  showAlert("requests", "");
  const btn = e.currentTarget;
  setBusy(btn, true);
  try { await loadRequests(); } catch (err) { showAlert("requests", err.message); } finally { setBusy(btn, false); }
});
$("#reqFilter").addEventListener("change", () => $("#reqRefresh").click());

function toggleMap(card, btn) {
  const box = $(".mini-map", card);
  const open = box.hidden;
  box.hidden = !open;
  btn.textContent = open ? "Hide map" : "View on map";
  if (!open) return;
  if (maps.has(box)) { maps.get(box).invalidateSize(); return; }
  const pos = [Number(card.dataset.lat), Number(card.dataset.lng)];
  const map = L.map(box, { scrollWheelZoom: false }).setView(pos, 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const pin = L.divIcon({ className: "pin", html: "<span></span>", iconSize: [26, 34], iconAnchor: [13, 34], popupAnchor: [0, -30] });
  L.marker(pos, { icon: pin }).addTo(map).bindPopup(`<strong>${esc(card.dataset.name)}</strong>`);
  const mine = bankCoords();
  if (mine) {
    L.circleMarker(mine, { radius: 8, color: "#fff", weight: 3, fillColor: "#1565C0", fillOpacity: 1 }).addTo(map).bindPopup("Your blood bank");
    map.fitBounds(L.latLngBounds([pos, mine]), { padding: [40, 40], maxZoom: 14 });
  }
  maps.set(box, map);
  setTimeout(() => map.invalidateSize(), 50);
}

$("#reqList").addEventListener("click", async (e) => {
  const card = e.target.closest(".req");
  if (!card) return;
  const mapBtn = e.target.closest("[data-map]");
  if (mapBtn) { toggleMap(card, mapBtn); return; }
  const act = e.target.closest("[data-act]");
  if (!act) return;
  showAlert("requests", "");
  const buttons = $$("button", card);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const id = requireBank();
    const status = act.dataset.act;
    const reason = status === "accepted" ? "" : $(".reason", card).value.trim();
    const r = await api(`/blood-banks/${id}/hospital-requests/${encodeURIComponent(card.dataset.id)}`, {
      method: "PATCH", body: compact({ status, rejection_reason: reason }),
    });
    await loadRequests();
    showAlert("requests", r.message, "ok");
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    showAlert("requests", err.message);
  }
});

/* ───────────── 8. Dashboard + start-up ───────────── */
async function renderDashboard() {
  const box = $("#dashBody");
  const id = bankId();
  if (!id) {
    box.innerHTML = `<div class="box box--wide"><h3>Welcome</h3>
      <p>Register a new blood bank, or paste an existing bank_id in the banner above to load it.</p>
      <div class="btn-row"><button class="btn" type="button" data-goto="register">Register a blood bank</button>
      <button class="btn btn--ghost" type="button" data-action="focus-bank">I have a bank_id</button></div></div>`;
    return;
  }
  const d = local();
  const mine = bankCoords();
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><b id="statOpen">…</b><span>Open hospital requests</span></div>
      <div class="stat"><b>${d.donors.length}</b><span>Private donors (this browser)</span></div>
      <div class="stat"><b>${d.quests.length}</b><span>Quests created (this browser)</span></div>
      <div class="stat"><b>${d.camps.length}</b><span>Camps created (this browser)</span></div>
    </div>
    <div class="grid-2">
      <div class="box"><h3>${esc(store.get(KEYS.name) || "Blood bank")}</h3>
        ${kv([["Bank ID", `<code>${esc(id)}</code>${copyBtn(id)}`], ["Location", mine ? `${esc(mine[0])}, ${esc(mine[1])}` : ""]])}
        <p class="muted" style="margin-top:12px">Switch profile any time with the banner at the top.</p></div>
      <div class="box"><h3>Quick actions</h3>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn--sm" type="button" data-goto="quests">New emergency quest</button>
          <button class="btn btn--ghost btn--sm" type="button" data-goto="private">Add private donor</button>
          <button class="btn btn--ghost btn--sm" type="button" data-goto="camps">Host a camp</button>
          <button class="btn btn--ghost btn--sm" type="button" data-goto="scanner">Check in a donor</button>
          <button class="btn btn--ghost btn--sm" type="button" data-goto="requests">Hospital requests</button>
        </div></div>
    </div>`;
  try {
    const r = await api(`/blood-banks/${id}/hospital-requests?status=open`);
    if ($("#statOpen")) $("#statOpen").textContent = r.count;
  } catch (err) {
    if ($("#statOpen")) $("#statOpen").textContent = "—";
    if (err.status === 0 || err.status === 404) showAlert("banner", err.message);
  }
}

initAlerts();
setSide(store.get(KEYS.side) === "1");
setBadge();
renderPrivateList();
renderCampList();
fillQuestList();
fillTargetList();
showTab("dashboard", { scroll: false });
if (bankId()) loadBank(bankId()).catch((err) => showAlert("banner", err.message));
