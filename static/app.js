const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let students = [];
let classes = [];
let crebos = [];
let cohorts = [];
let leertrajecten = [];
let subjects = [];
let periods = [];
let grades = {}; // "studentId:subjectId" -> value
let attendance = {}; // studentId -> {present, absent_allowed, absent_unallowed}
let notes = {}; // studentId -> {comment, teacher_comment}
let currentPeriod = null;
let users = [];
let settings = { school_name: "", logo: "" };
let pendingLogo = null;

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let currentUser = null;

const listSort = {
  students: { key: "name", dir: 1 },
  crebos: { key: "name", dir: 1 },
  cohorts: { key: "name", dir: 1 },
  leertrajecten: { key: "name", dir: 1 },
  kdmatrix: { key: "last_name", dir: 1 },
  kdbulk: { key: "last_name", dir: 1 },
  kdtable: { key: "name", dir: 1 },
  meetings: { key: "meeting_date", dir: -1 },
  classes: { key: "name", dir: 1 },
  subjects: { key: "name", dir: 1 },
  periods: { key: "year", dir: 1 },
  grades: { key: "last_name", dir: 1 },
  users: { key: "username", dir: 1 },
};

function sortRows(rows, state, fieldOf) {
  if (!state || !state.key) return rows;
  const dir = state.dir;
  return [...rows].sort((a, b) => {
    const av = fieldOf(a, state.key);
    const bv = fieldOf(b, state.key);
    const na = parseFloat(av);
    const nb = parseFloat(bv);
    if (av !== "" && av !== null && bv !== "" && bv !== null &&
        !isNaN(na) && !isNaN(nb)) {
      return na < nb ? -dir : na > nb ? dir : 0;
    }
    const sav = (av || "").toString().toLowerCase();
    const sbv = (bv || "").toString().toLowerCase();
    return sav < sbv ? -dir : sav > sbv ? dir : 0;
  });
}

const SORT_LABELS = {};

function updateSortArrows(tableSel, state) {
  document.querySelectorAll(tableSel + " thead th[data-key]").forEach((th) => {
    const key = tableSel + "|" + th.dataset.key;
    if (!(key in SORT_LABELS)) SORT_LABELS[key] = th.textContent.trim();
    const label = SORT_LABELS[key];
    const mark = th.dataset.key === state.key
      ? (state.dir === 1 ? "\u25BE" : "\u25B4")
      : "\u21C5";
    const cls = th.dataset.key === state.key ? "sort-indicator active" : "sort-indicator";
    th.innerHTML = esc(label) + ` <span class="${cls}">${mark}</span>`;
  });
}

function bindTableSort(tableSel, stateKey, rerender) {
  document.querySelector(tableSel + " thead").addEventListener("click", (e) => {
    const key = e.target.dataset.key;
    if (key === undefined) return;
    const state = listSort[stateKey];
    if (state.key === key) state.dir = state.dir === 1 ? -1 : 1;
    else { state.key = key; state.dir = 1; }
    rerender();
  });
}

// ---------- Voorbeeldbestanden (templates) voor CSV-import ----------
const IMPORT_TEMPLATES = {
  cijfers: {
    file: "voorbeeld-cijfers.csv",
    text: "Studentnummer;Vaknaam 1;Vaknaam 2\n210001;7,5;VS\n210002;O;5,2\n",
  },
  keuzedeel: {
    file: "voorbeeld-keuzedeel-resultaten.csv",
    text: "Studentnummer;Resultaat\n10001;8\n10002;VS\n10003;G\n",
  },
  studenten: {
    file: "voorbeeld-studenten.csv",
    text: "Studentnummer,Voornaam,Tussenvoegsel,Achternaam,Email,Klas\n"
          + "1001,Jan,van,Jansen,jan@school.nl,IAO4A\n"
          + "1002,Piet,,Pietersen,piet@school.nl,IAO3B\n",
  },
  vakken: {
    file: "voorbeeld-vakken.csv",
    text: "Vak,Beoordeling\nNederlands,cijfer\nRekenen,cijfer\nProjectvaardigheden,letter\nStage,vnv\n",
  },
  gebruikers: {
    file: "voorbeeld-gebruikers.csv",
    text: "Gebruikersnaam,Wachtwoord,Rol,Voornaam,Achternaam,Email\n"
          + "mjansma,wachtwoord1,docent,Marijke,Jansma,m.jansma@school.nl\n"
          + "hdeboer,wachtwoord2,mentor,Henk,de Boer,h.deboer@school.nl\n",
  },
};

document.addEventListener("click", (e) => {
  const link = e.target.closest(".template-link");
  if (!link) return;
  e.preventDefault();
  const tpl = IMPORT_TEMPLATES[link.dataset.template];
  if (!tpl) return;
  const blob = new Blob(["\ufeff" + tpl.text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = tpl.file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});

// ---------- Paginering ----------
const PAGE_SIZES = [25, 50, 100, 250];
const pagers = {};

function pagerState(tableSel) {
  if (!pagers[tableSel]) pagers[tableSel] = { page: 1, size: 50 };
  return pagers[tableSel];
}

function resetPage(tableSel) {
  const p = pagers[tableSel];
  if (p) p.page = 1;
}

function pageSlice(tableSel, rows) {
  const p = pagerState(tableSel);
  const pages = Math.max(1, Math.ceil(rows.length / p.size));
  if (p.page > pages) p.page = pages;
  if (p.page < 1) p.page = 1;
  const start = (p.page - 1) * p.size;
  renderPager(tableSel, rows.length, start);
  return rows.slice(start, start + p.size);
}

function renderPager(tableSel, total, start) {
  const el = document.querySelector(`.pager[data-table="${tableSel.slice(1)}"]`);
  if (!el) return;
  if (total <= PAGE_SIZES[0]) { el.innerHTML = ""; return; }
  const p = pagers[tableSel];
  const pages = Math.max(1, Math.ceil(total / p.size));
  const from = start + 1;
  const to = Math.min(total, start + p.size);
  el.innerHTML = `
    <button class="secondary" data-page="prev"${from === 1 ? " disabled" : ""}>\u25C0</button>
    <span class="pager-info">Pagina ${p.page} / ${pages} &mdash; ${from}&ndash;${to} van ${total}</span>
    <button class="secondary" data-page="next"${to >= total ? " disabled" : ""}>\u25B6</button>
    <label class="pager-size">Per pagina
      <select data-page-size>
        ${PAGE_SIZES.map((n) => `<option value="${n}"${n === p.size ? " selected" : ""}>${n}</option>`).join("")}
      </select>
    </label>`;
}

function rerenderPagedTable(tableSel) {
  const fn = {
    "#grade-table": renderGradeTable,
    "#students-table": renderStudents,
    "#classes-table": renderClasses,
    "#crebos-table": renderCrebos,
    "#cohorts-table": renderCohorts,
    "#leertrajecten-table": renderLeertrajecten,
    "#subjects-table": renderSubjects,
    "#periods-table": renderPeriods,
    "#users-table": renderUsers,
    "#arch-students-table": () => renderArchTable("arch-students-table"),
    "#arch-classes-table": () => renderArchTable("arch-classes-table"),
    "#arch-subjects-table": () => renderArchTable("arch-subjects-table"),
    "#arch-cohorts-table": () => renderArchTable("arch-cohorts-table"),
    "#arch-leertrajecten-table": () => renderArchTable("arch-leertrajecten-table"),
    "#audit-table": renderAuditTable,
    "#stat-subjects-table": () => renderStatOverview(),
    "#stat-signals-table": () => renderStatOverview(),
    "#kd-matrix-table": renderKdMatrix,
  }[tableSel];
  if (fn) fn();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pager [data-page]");
  if (!btn || btn.disabled) return;
  const pagerEl = btn.closest(".pager");
  const tableSel = "#" + pagerEl.dataset.table;
  const p = pagers[tableSel];
  if (!p) return;
  p.page += btn.dataset.page === "prev" ? -1 : 1;
  rerenderPagedTable(tableSel);
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest(".pager [data-page-size]");
  if (!sel) return;
  const pagerEl = sel.closest(".pager");
  const tableSel = "#" + pagerEl.dataset.table;
  const p = pagers[tableSel];
  if (!p) return;
  p.size = +sel.value;
  p.page = 1;
  rerenderPagedTable(tableSel);
});

const ROLE_LABELS = {
  beheerder: "Beheerder", mentor: "Mentor", docent: "Docent",
  administratie: "Administratie", student: "Student",
};

const ROLE_TABS = {
  beheerder: ["cijfers", "studenten", "structuur", "vakken", "periodes", "keuzedelen", "statistieken", "rapport", "vergadering", "archief", "gebruikers", "instellingen", "logboek"],
  mentor: ["cijfers", "studenten", "keuzedelen", "statistieken", "rapport", "vergadering", "archief", "logboek"],
  docent: ["cijfers", "keuzedelen", "statistieken", "rapport", "vergadering", "logboek"],
  administratie: ["keuzedelen", "statistieken", "rapport", "logboek"],
  student: ["rapport"],
};

const isRole = (...roles) => currentUser && roles.includes(currentUser.role);
const maySetGrades = () => isRole("beheerder", "docent");
const maySetAttendanceNotes = () => isRole("beheerder", "docent", "mentor");
const isAdmin = () => isRole("beheerder");

function ownClassesOnly(list) {
  if (!currentUser || currentUser.role !== "mentor") return list;
  return list.filter((c) => String(c.mentor_id) === String(currentUser.id));
}

function activateGroupOf(tabName) {
  $$(".tab-group").forEach((g) => {
    const btn = g.querySelector(".tab-group-btn");
    if (btn) btn.classList.toggle("active",
      !!g.querySelector(`[data-tab="${tabName}"]`));
  });
}

function closeTabMenus() {
  $$(".tab-group.open").forEach((g) => g.classList.remove("open"));
}

function applyRoleUi() {
  const role = currentUser ? currentUser.role : null;
  $$(".tab[data-tab]").forEach((btn) => {
    btn.style.display = role && ROLE_TABS[role].includes(btn.dataset.tab) ? "" : "none";
  });
  $$(".tab-group").forEach((g) => {
    const anyVisible = [...g.querySelectorAll("[data-tab]")]
      .some((b) => b.style.display !== "none");
    g.style.display = anyVisible ? "" : "none";
  });
  $("#user-info").textContent = currentUser
    ? `${currentUser.username} (${ROLE_LABELS[currentUser.role] || currentUser.role})` : "";
  const isStudent = role === "student";
  const reportStudentSel = $("#report-student");
  const reportAudience = $("#report-audience");
  if (reportStudentSel) reportStudentSel.disabled = isStudent;
  if (reportAudience) {
    if (isStudent) { reportAudience.value = "student"; reportAudience.disabled = true; }
    else reportAudience.disabled = false;
  }
  const gradeImport = $("#grade-import-ui");
  if (gradeImport) gradeImport.style.display = maySetGrades() ? "" : "none";
  const studentImport = $("#student-import-ui");
  if (studentImport) studentImport.style.display = isAdmin() ? "" : "none";
  $$("#tab-structuur .admin-only").forEach((el) => {
    el.style.display = isAdmin() ? "" : "none";
  });
  const kdAddBar = $("#kd-add-bar");
  if (kdAddBar) kdAddBar.style.display = isAdmin() ? "" : "none";
  const kdImportBar = $("#kd-import-bar");
  if (kdImportBar) kdImportBar.style.display = maySetGrades() || isRole("mentor") ? "" : "none";
  const mayLinkKd = isRole("beheerder", "mentor");
  for (const id of ["btn-kd-bulk-link", "btn-kd-bulk-unlink"]) {
    const el = $("#" + id);
    if (el) el.style.display = mayLinkKd ? "" : "none";
  }
}

function renderStudentReportUi() {
  const sel = $("#report-period");
  sel.innerHTML = `<option value="all">Alle modules (totaal)</option>` +
    periods.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("");
  for (const id of ["report-student", "report-class", "report-cohort", "report-audience"]) {
    const el = $("#" + id);
    if (el) el.parentElement.style.display = "none";
  }
}

function activateDefaultTab() {
  $$(".panel").forEach((p) => p.classList.remove("hidden", "active"));
  $$(".tab[data-tab]").forEach((b) => b.classList.remove("active"));
  const firstTab = [...$$(".tab[data-tab]")].find((b) => b.style.display !== "none");
  if (firstTab) {
    firstTab.classList.add("active");
    $(`#tab-${firstTab.dataset.tab}`).classList.add("active");
    activateGroupOf(firstTab.dataset.tab);
  }
}

function applySchoolName() {
  const name = settings.school_name || "MBO ICT-opleiding";
  document.title = `RapportApp \u2014 ${name}`;
  const headerH1 = $("#app-header h1");
  if (headerH1) headerH1.textContent = `RapportApp \u2014 ${name}`;
  const loginH1 = $("#login-screen h1");
  if (loginH1) loginH1.textContent = `RapportApp \u2014 ${name}`;
}

async function init() {
  settings = Object.assign({ school_name: "", logo: "" },
    await api("/api/settings").catch(() => ({})));
  applySchoolName();
  renderSettingsUi();
  try {
    currentUser = await api("/api/auth/me");
  } catch (e) {
    currentUser = null;
  }
  if (!currentUser) {
    $("#login-screen").classList.remove("hidden");
    $("#app-header").classList.add("hidden");
    $$(".panel").forEach((p) => p.classList.add("hidden"));
    return;
  }
  $("#login-screen").classList.add("hidden");
  $("#app-header").classList.remove("hidden");
  applyRoleUi();
  activateDefaultTab();
  if (currentUser.must_change_password) showPasswordChangeDialog();
  settings = Object.assign({ school_name: "", logo: "" },
    await api("/api/settings").catch(() => ({})));
  applySchoolName();
  renderSettingsUi();
  await loadAll();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").classList.add("hidden");
  try {
    currentUser = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#login-username").value,
        password: $("#login-password").value,
      }),
    });
    $("#login-password").value = "";
    await init();
  } catch (err) {
    const el = $("#login-error");
    el.textContent = err.message;
    el.classList.remove("hidden");
  }
});

$("#btn-logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

// ---------- Snelkoppelingen: doelblok automatisch openen ----------
$$(".quicknav a").forEach((a) => a.addEventListener("click", () => {
  const target = document.querySelector(a.getAttribute("href"));
  if (target && target.tagName === "DETAILS") target.open = true;
}));

// ---------- Tabs ----------
$$("nav [data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab[data-tab]").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active", "hidden"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    activateGroupOf(btn.dataset.tab);
    closeTabMenus();
  });
});

$$(".tab-group-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const group = btn.closest(".tab-group");
    const visible = [...group.querySelectorAll("[data-tab]")]
      .filter((b) => b.style.display !== "none");
    if (visible.length === 1) {
      visible[0].click();
      return;
    }
    const wasOpen = group.classList.contains("open");
    closeTabMenus();
    if (!wasOpen) group.classList.add("open");
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".tab-group")) closeTabMenus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTabMenus();
});

// ---------- Loaders ----------
async function loadAll() {
  if (currentUser && currentUser.role === "student") {
    periods = await api("/api/periods");
    renderStudentReportUi();
    return;
  }
  [students, classes, crebos, cohorts, leertrajecten, subjects, periods] = await Promise.all([
    api("/api/students"), api("/api/classes"), api("/api/crebos"), api("/api/cohorts"), api("/api/leertrajecten"), api("/api/subjects"), api("/api/periods"),
  ]);
  if (currentUser && currentUser.role === "beheerder") {
    users = await api("/api/users").catch(() => []);
    renderUsers();
  }
  students.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  classes.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  crebos.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  subjects.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  leertrajecten.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  renderPeriodSelects();
  renderStudents();
  renderClasses();
  renderSubjects();
  renderPeriods();
  renderGradeTable();
  if (periods.length && !currentPeriod) {
    currentPeriod = periods[0].id;
    $("#grade-period").value = currentPeriod;
  }
  await loadGrades();
}

function periodsForClass(classId) {
  if (!classId) return periods;
  const c = classes.find((x) => String(x.id) === String(classId));
  const ltId = c ? c.leertraject_id : null;
  if (!ltId) return periods;
  const result = periods.filter((p) =>
    !(p.leertraject_ids || []).length || p.leertraject_ids.includes(ltId));
  return result.length ? result : periods;
}

function renderPeriodSelects() {
  const gradePeriods = periodsForClass($("#grade-class").value);
  $("#grade-period").innerHTML = gradePeriods.map((p) =>
    `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("");
  if (currentPeriod && !gradePeriods.some((p) => p.id === currentPeriod)) {
    currentPeriod = gradePeriods.length ? gradePeriods[0].id : null;
    loadGrades();
  }
  if ($("#grade-period").value !== String(currentPeriod) && currentPeriod) {
    $("#grade-period").value = currentPeriod;
  }
  const reportSel = $("#report-period");
  if (reportSel) {
    const isStudent = currentUser && currentUser.role === "student";
    const reportPeriods = isStudent ? periods : periodsForClass($("#report-class").value);
    reportSel.innerHTML = `<option value="all">Alle modules (totaal)</option>` +
      reportPeriods.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("");
  }
  const rs = $("#report-student");
  rs.innerHTML = `<option value="">Alle studenten</option>` +
    students.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  renderClassSelects();
  for (const sel of [$("#student-cohort"), $("#report-cohort"), $("#grade-cohort"), $("#kd-matrix-cohort"), $("#kd-bulk-cohort")]) {
    sel.innerHTML = `<option value="">Alle cohorten</option>` +
      cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  }
  for (const kbc of [$("#kd-matrix-class"), $("#kd-bulk-class")]) {
    const kbcPrev = kbc.value;
    kbc.innerHTML = `<option value="">Alle klassen</option>` +
      classes.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
    if (kbcPrev && [...kbc.options].some((o) => o.value === kbcPrev)) kbc.value = kbcPrev;
  }
  const scFilter = $("#student-cohort") ? $("#student-cohort").value : "";
  const scList = ownClassesOnly(scFilter
    ? classes.filter((c) => String(c.cohort_id) === scFilter)
    : classes);
  const scSel = $("#student-class-filter");
  const scPrev = scSel.value;
  scSel.innerHTML = `<option value="">Alle klassen</option>` +
    scList.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
  if (scPrev && ![...scSel.options].some((o) => o.value === scPrev)) scSel.value = "";
}

function renderClassSelects() {
  const cohortFilter = $("#grade-cohort").value;
  const reportCohortFilter = $("#report-cohort").value;
  const visibleClasses = ownClassesOnly(cohortFilter
    ? classes.filter((c) => String(c.cohort_id) === cohortFilter)
    : classes);
  const reportClasses = ownClassesOnly(reportCohortFilter
    ? classes.filter((c) => String(c.cohort_id) === reportCohortFilter)
    : classes);
  const grouped = (sel, list) => {
    const byCohort = {};
    for (const c of list) {
      const key = c.cohort || "Zonder cohort";
      (byCohort[key] = byCohort[key] || []).push(c);
    }
    const groups = Object.entries(byCohort).map(([cohort, cls]) =>
      `<optgroup label="Cohort ${esc(cohort)}">` +
      cls.map((c) => `<option value="${c.id}"${String(sel) === String(c.id) ? " selected" : ""}>${esc(classLabel(c))}</option>`).join("") +
      `</optgroup>`).join("");
    return `<option value="">Alle klassen</option>` + groups;
  };
  const gradeSel = $("#grade-class");
  const prevGrade = gradeSel.value;
  gradeSel.innerHTML = grouped(prevGrade, visibleClasses);
  const reportSel = $("#report-class");
  const prevReport = reportSel.value;
  const reportInList = reportClasses.some((c) => String(c.id) === String(prevReport));
  reportSel.innerHTML = grouped(reportInList ? prevReport : "", reportClasses);
  if (!reportInList) reportSel.value = "";
  $("#student-class").innerHTML = `<option value="">Geen klas</option>` +
    ownClassesOnly(classes).map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
}

function studentName(s) {
  if (s.first_name || s.last_name) {
    return [s.first_name, s.prefix, s.last_name].filter(Boolean).join(" ");
  }
  return s.name || "";
}

function classLabel(c) {
  return c.crebo ? `${c.name} (${c.crebo})` : c.name;
}

function visibleStudents() {
  const classId = $("#grade-class").value;
  let list = classId ? students.filter((s) => String(s.class_id) === classId) : students;
  if (!classId) {
    const cohortId = $("#grade-cohort").value;
    if (cohortId) list = students.filter((s) => {
      const c = classes.find((x) => x.id === s.class_id);
      return c && String(c.cohort_id) === cohortId;
    });
  }
  const q = $("#grade-search") ? $("#grade-search").value.trim().toLowerCase() : "";
  if (q) {
    list = list.filter((s) => studentName(s).toLowerCase().includes(q) ||
      (s.student_number || "").toLowerCase().includes(q));
  }
  return list;
}

function subjectsForPeriod() {
  if (!currentPeriod) return subjects;
  const classId = +($("#grade-class").value || 0) || null;
  const cls = classes.find((x) => String(x.id) === String(classId));
  const ltId = cls ? cls.leertraject_id : null;
  return subjects.filter((s) =>
    (s.kind || "vak") === "vak" &&
    (s.period_ids || []).includes(currentPeriod)
  );
}

async function loadGrades() {
  if (!currentPeriod) { renderGradeTable(); return; }
  const rows = await api(`/api/grades?period_id=${currentPeriod}`);
  grades = {};
  for (const r of rows) grades[`${r.student_id}:${r.subject_id}`] = r.value;
  const attRows = await api(`/api/attendance?period_id=${currentPeriod}`);
  attendance = {};
  for (const r of attRows) attendance[r.student_id] = r;
  const noteRows = await api(`/api/notes?period_id=${currentPeriod}`);
  notes = {};
  for (const r of noteRows) notes[r.student_id] = r;
  renderGradeTable();
}

// ---------- Cijfermatrix ----------
function gradeColumnOrder() {
  try { return JSON.parse(localStorage.getItem("rapportapp-grade-order") || "[]"); }
  catch { return []; }
}

function orderGradeColumns(list) {
  const order = gradeColumnOrder();
  if (!order.length) return list;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) =>
    (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

let dragSubjectId = null;

function renderGradeTable() {
  const thead = $("#grade-table thead");
  const tbody = $("#grade-table tbody");
  if (!subjects.length || !students.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td>Voeg eerst ${subjects.length ? "studenten" : "vakken"} toe.</td></tr>`;
    return;
  }
  const periodSubjects = orderGradeColumns(subjectsForPeriod());
  const typeShort = { cijfer: "1-10", letter: "V/G/O/VS", vnv: "V/NV" };
  const gradeDis = maySetGrades() ? "" : " disabled";
  const attDis = maySetAttendanceNotes() ? "" : " disabled";
  thead.innerHTML = `<tr><th data-key="student_number">Nr.</th><th data-key="first_name">Voornaam</th><th data-key="prefix">Tussenv.</th><th data-key="last_name">Achternaam</th>` +
    periodSubjects.map((s) => `<th draggable="true" data-subject="${s.id}" title="Beoordeling: ${typeShort[s.assessment_type] || "1-10"} — sleep om te herschikken">${esc(s.name)}<br><small>${typeShort[s.assessment_type] || "1-10"}</small></th>`).join("") +
    `<th title="Aanwezigheid">Aanw. %</th>` +
    `<th title="Geoorloofd afwezig">Geoorl. afw. %</th>` +
    `<th title="Ongeoorloofd afwezig">Ongeoorl. afw. %</th>` +
    `<th title="Opmerkingen (zichtbaar op studentrapport)">Opmerkingen</th>` +
    `<th title="Opmerking docenten (alleen op docentenrapport)">Opm. docenten</th>` +
    `<th data-key="tekorten">Tekorten</th></tr>`;
  updateSortArrows("#grade-table", listSort.grades);

  const periodSubjectsForSort = periodSubjects;
  const tekortTotal = (st) => periodSubjectsForSort.reduce(
    (sum, su) => sum + tekorten(grades[`${st.id}:${su.id}`] || ""), 0);
  const gradeRows = sortRows(visibleStudents(), listSort.grades, (st, key) =>
    key === "tekorten" ? String(tekortTotal(st)).padStart(3, "0")
    : (st[key] || ""));
  tbody.innerHTML = pageSlice("#grade-table", gradeRows).map((st) => {
    let total = 0;
    const cells = periodSubjects.map((su) => {
      const key = `${st.id}:${su.id}`;
      const v = grades[key] || "";
      total += tekorten(v);
      const cls = v && tekorten(v) > 0 ? ` class="tekort-${tekorten(v)}"` : "";
      const kind = gradeKind(v);
      return `<td${cls}><input class="cell${kind ? " val-" + kind : ""}" data-sid="${st.id}" data-suid="${su.id}" value="${esc(v)}"${gradeDis}></td>`;
    }).join("");
    const att = attendance[st.id] || {};
    const attCell = (field, cls) => {
      const v = att[field] === null || att[field] === undefined ? "" : att[field];
      const kind = cls === "att-present" && v !== "" && parseFloat(v) < 85 ? " att-onv" : "";
      return `<td><input class="cell ${cls}${kind}" data-att="${field}" data-sid="${st.id}" value="${esc(v)}"${attDis}></td>`;
    };
    return `<tr><td>${esc(st.student_number || "")}</td><td>${esc(st.first_name || "")}</td><td>${esc(st.prefix || "")}</td><td>${esc(st.last_name || "")}</td>${cells}` +
      attCell("present", "att-present") +
      attCell("absent_allowed", "att-allowed") +
      attCell("absent_unallowed", "att-unallowed") +
      `<td><input class="cell note-cell note-open" data-note="comment" data-sid="${st.id}" value="${esc((notes[st.id] || {}).comment || "")}" title="Klik om te bewerken" readonly${attDis}></td>` +
      `<td><input class="cell note-cell note-open" data-note="teacher_comment" data-sid="${st.id}" value="${esc((notes[st.id] || {}).teacher_comment || "")}" title="Klik om te bewerken" readonly${attDis}></td>` +
      `<td class="total" data-total="${st.id}" data-name="${esc(st.name)}">${total}</td></tr>`;
  }).join("");

  tbody.querySelectorAll("input.cell").forEach((inp) => {
    if (inp.dataset.note) {
      inp.addEventListener("change", () => saveNote(inp));
    } else if (inp.dataset.att) {
      inp.addEventListener("change", () => saveAttendance(inp));
    } else {
      inp.addEventListener("change", () => saveCell(inp));
    }
    inp.addEventListener("focus", () => inp.select());
  });
}

function tekorten(v) {
  if (!v) return 0;
  if (v === "V" || v === "G" || v === "VS") return 0;
  if (v === "O" || v === "NV") return 1;
  const n = Math.round(parseFloat(v));
  return n < 6 ? 6 - n : 0;
}

function gradeKind(v) {
  if (!v) return "";
  if (v === "VS") return "vs";
  if (v === "O" || v === "NV" || tekorten(v) > 0) return "onv";
  return "vol";
}

async function saveCell(inp) {
  const body = {
    student_id: +inp.dataset.sid,
    subject_id: +inp.dataset.suid,
    period_id: currentPeriod,
    value: inp.value,
  };
  try {
    const res = await api("/api/grades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    grades[`${body.student_id}:${body.subject_id}`] = res.value;
    inp.value = res.value;
    const kind = gradeKind(res.value);
    inp.className = "cell" + (kind ? " val-" + kind : "");
    updateTotals();
  } catch (e) {
    alert(e.message);
    inp.value = grades[`${body.student_id}:${body.subject_id}`] || "";
  }
}

async function saveNote(inp) {
  const sid = +inp.dataset.sid;
  const cur = notes[sid] || { comment: "", teacher_comment: "" };
  const payload = {
    student_id: sid,
    period_id: currentPeriod,
    comment: inp.dataset.note === "comment" ? inp.value : (cur.comment || ""),
    teacher_comment: inp.dataset.note === "teacher_comment" ? inp.value : (cur.teacher_comment || ""),
  };
  try {
    await api("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    notes[sid] = { comment: payload.comment, teacher_comment: payload.teacher_comment };
  } catch (e) {
    alert(e.message);
  }
}

let noteEdit = null;

function openNoteDialog(sid, field) {
  if (!maySetAttendanceNotes()) return;
  noteEdit = { sid, field };
  const st = students.find((s) => s.id === sid);
  const label = field === "comment" ? "Opmerkingen" : "Opmerking docenten";
  $("#note-dialog-title").textContent = `${label} \u2014 ${st ? studentName(st) : ""}`;
  $("#note-dialog-area").value = (notes[sid] || {})[field] || "";
  $("#note-dialog").classList.remove("hidden");
  $("#note-dialog-area").focus();
}

function closeNoteDialog() {
  $("#note-dialog").classList.add("hidden");
  noteEdit = null;
}

$("#grade-table tbody").addEventListener("click", (e) => {
  const inp = e.target.closest("input.note-open");
  if (!inp || inp.disabled) return;
  openNoteDialog(+inp.dataset.sid, inp.dataset.note);
});

$("#btn-note-save").addEventListener("click", async () => {
  if (!noteEdit) return;
  const { sid, field } = noteEdit;
  const cur = notes[sid] || { comment: "", teacher_comment: "" };
  const value = $("#note-dialog-area").value;
  const payload = {
    student_id: sid,
    period_id: currentPeriod,
    comment: field === "comment" ? value : (cur.comment || ""),
    teacher_comment: field === "teacher_comment" ? value : (cur.teacher_comment || ""),
  };
  try {
    await api("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    notes[sid] = { comment: payload.comment, teacher_comment: payload.teacher_comment };
    closeNoteDialog();
    renderGradeTable();
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
});

$("#btn-note-cancel").addEventListener("click", closeNoteDialog);
$("#note-dialog").addEventListener("click", (e) => {
  if (e.target.id === "note-dialog") closeNoteDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && noteEdit) closeNoteDialog();
});

async function saveAttendance(inp) {
  const sid = +inp.dataset.sid;
  const att = attendance[sid] || { present: null, absent_allowed: null, absent_unallowed: null };
  att[inp.dataset.att] = inp.value;
  try {
    const res = await api("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: sid,
        period_id: currentPeriod,
        present: att.present ?? "",
        absent_allowed: att.absent_allowed ?? "",
        absent_unallowed: att.absent_unallowed ?? "",
      }),
    });
    if (res.ok) {
      const fresh = await api(`/api/attendance?period_id=${currentPeriod}`);
      attendance = {};
      for (const r of fresh) attendance[r.student_id] = r;
      renderGradeTable();
    }
  } catch (e) {
    alert(e.message);
    renderGradeTable();
  }
}

function updateTotals() {
  for (const cell of $$("td[data-total]")) {
    const sid = +cell.dataset.total;
    let total = 0;
    for (const su of subjectsForPeriod()) total += tekorten(grades[`${sid}:${su.id}`] || "");
    cell.textContent = total;
  }
}

// Kolommen in het cijferoverzicht herschikken door te slepen.
$("#grade-table thead").addEventListener("dragstart", (e) => {
  const th = e.target.closest("th[data-subject]");
  if (!th) return;
  dragSubjectId = +th.dataset.subject;
  e.dataTransfer.effectAllowed = "move";
});
$("#grade-table thead").addEventListener("dragover", (e) => {
  if (dragSubjectId !== null && e.target.closest("th[data-subject]")) e.preventDefault();
});
$("#grade-table thead").addEventListener("drop", (e) => {
  const th = e.target.closest("th[data-subject]");
  if (!th || dragSubjectId === null) return;
  e.preventDefault();
  const targetId = +th.dataset.subject;
  const visible = orderGradeColumns(subjectsForPeriod()).map((s) => s.id);
  const from = visible.indexOf(dragSubjectId);
  if (from !== -1 && targetId !== dragSubjectId) {
    visible.splice(from, 1);
    const to = visible.indexOf(targetId);
    visible.splice(to === -1 ? visible.length : to, 0, dragSubjectId);
    localStorage.setItem("rapportapp-grade-order", JSON.stringify(visible));
    renderGradeTable();
  }
  dragSubjectId = null;
});
$("#grade-table thead").addEventListener("dragend", () => { dragSubjectId = null; });

$("#grade-period").addEventListener("change", async (e) => {
  currentPeriod = +e.target.value;
  await loadGrades();
});

$("#grade-class").addEventListener("change", () => { renderPeriodSelects(); renderGradeTable(); });
$("#grade-search").addEventListener("input", () => { resetPage("#grade-table"); renderGradeTable(); });

$("#grade-cohort").addEventListener("change", () => {
  renderClassSelects();
  renderGradeTable();
});

$("#student-search").addEventListener("input", () => { resetPage("#students-table"); renderStudents(); });
$("#student-cohort").addEventListener("change", () => {
  renderPeriodSelects();
  resetPage("#students-table");
  renderStudents();
});
$("#student-class-filter").addEventListener("change", () => { resetPage("#students-table"); renderStudents(); });

bindTableSort("#students-table", "students", renderStudents);
bindTableSort("#classes-table", "classes", renderClasses);
bindTableSort("#crebos-table", "crebos", renderCrebos);
bindTableSort("#cohorts-table", "cohorts", renderCohorts);
bindTableSort("#leertrajecten-table", "leertrajecten", renderLeertrajecten);
bindTableSort("#subjects-table", "subjects", renderSubjects);
bindTableSort("#periods-table", "periods", renderPeriods);
bindTableSort("#grade-table", "grades", renderGradeTable);
bindTableSort("#users-table", "users", renderUsers);

$("#users-search").addEventListener("input", () => { resetPage("#users-table"); renderUsers(); });
$("#users-role-filter").addEventListener("change", () => { resetPage("#users-table"); renderUsers(); });
$("#users-active-filter").addEventListener("change", () => { resetPage("#users-table"); renderUsers(); });

$("#class-search").addEventListener("input", () => { resetPage("#classes-table"); renderClasses(); });
$("#period-search").addEventListener("input", () => { resetPage("#periods-table"); renderPeriods(); });

// ---------- Import: bestand ----------
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !currentPeriod) return;
  setImportBusy("#import-result", file.name);
  const fd = new FormData();
  fd.append("period_id", currentPeriod);
  fd.append("file", file);
  try {
    const res = await api("/api/import", { method: "POST", body: fd });
    showImportResult(res);
    await loadAll();
  } catch (err) {
    showImportResult({ errors: [err.message] });
  }
  e.target.value = "";
});

// ---------- Import: plakken ----------
function pasteMode() {
  const checked = document.querySelector('input[name="paste-mode"]:checked');
  return checked ? checked.value : "rows";
}

$("#btn-paste-open").addEventListener("click", () => {
  $("#paste-dialog").classList.remove("hidden");
  $("#paste-area").value = "";
  const subjSel = $("#paste-subject");
  subjSel.innerHTML = subjectsForPeriod().map((s) =>
    `<option value="${s.id}">${esc(s.name)}</option>`).join("") ||
    `<option value="">(geen vakken in deze module)</option>`;
  $("#paste-area").placeholder = pasteMode() === "column"
    ? "7,5\n6\nO\nVS\nof met naam: Jan Jansen\t7,5"
    : "Naam\tNederlands\tRekenen\nJan\t7,5\tVS\nPiet\tO\t5,2";
  $("#paste-area").focus();
});

document.querySelectorAll('input[name="paste-mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    const column = pasteMode() === "column";
    $("#paste-rows-hint").classList.toggle("hidden", column);
    $("#paste-column-controls").classList.toggle("hidden", !column);
    $("#paste-area").placeholder = column
      ? "7,5\n6\nO\nVS\nof met naam: Jan Jansen\t7,5"
      : "Naam\tNederlands\tRekenen\nJan\t7,5\tVS\nPiet\tO\t5,2";
  }));

$("#btn-paste-cancel").addEventListener("click", () => $("#paste-dialog").classList.add("hidden"));

function pasteColumnEntries(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const roster = sortRows(visibleStudents().filter((s) => !s.archived),
    listSort.grades, (st, key) => key === "tekorten" ? "" : (st[key] || ""));
  const byIdent = {};
  for (const s of roster) {
    byIdent[studentName(s).toLowerCase()] = s.id;
    if (s.student_number) byIdent[s.student_number.toLowerCase()] = s.id;
  }
  const entries = [];
  const errors = [];
  let idx = 0;
  for (const line of lines) {
    const sep = line.includes("\t") ? "\t" : line.includes(";") ? ";" : null;
    if (sep) {
      const [ident, value] = [line.split(sep)[0].trim(), line.split(sep).slice(1).join(sep).trim()];
      const sid = byIdent[ident.toLowerCase()];
      if (!sid) { errors.push(`Onbekende student: ${ident}`); continue; }
      entries.push({ student_id: sid, value });
    } else {
      const s = roster[idx++];
      if (!s) { errors.push(`Meer cijfers dan studenten op de lijst.`); break; }
      entries.push({ student_id: s.id, value: line });
    }
  }
  return { entries, errors, rosterSize: roster.length };
}

$("#btn-paste-import").addEventListener("click", async () => {
  const text = $("#paste-area").value.trim();
  if (!text || !currentPeriod) return;
  try {
    let res;
    if (pasteMode() === "column") {
      const subjectId = +$("#paste-subject").value;
      if (!subjectId) throw new Error("Kies eerst een vak.");
      const { entries, errors, rosterSize } = pasteColumnEntries(text);
      if (entries.length < rosterSize && !errors.length) {
        errors.push(`Let op: ${rosterSize - entries.length} student(en) op de lijst hebben geen cijfer gekregen.`);
      }
      res = await api("/api/grades/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject_id: subjectId, period_id: currentPeriod, entries }),
      });
      res.errors = [...errors, ...(res.errors || [])];
    } else {
      const fd = new FormData();
      fd.append("period_id", currentPeriod);
      fd.append("text", text);
      res = await api("/api/import", { method: "POST", body: fd });
    }
    showImportResult(res);
    $("#paste-dialog").classList.add("hidden");
    await loadAll();
  } catch (err) {
    showImportResult({ errors: [err.message] });
  }
});

function setImportBusy(sel, fileName) {
  const el = $(sel);
  el.classList.remove("hidden", "ok", "err");
  el.textContent = `Bezig met importeren van "${fileName}"...`;
}

function setResultKind(el, hasErrors) {
  el.classList.remove("ok", "err");
  el.classList.add(hasErrors ? "err" : "ok");
}

function showImportResult(res) {
  const el = $("#import-result");
  el.classList.remove("hidden");
  setResultKind(el, res.errors && res.errors.length);
  let msg = `Geïmporteerd: ${res.imported} cijfers`;
  if (res.skipped) msg += `, overgeslagen: ${res.skipped}`;
  if (res.errors && res.errors.length) msg += `\nFouten:\n` + res.errors.join("\n");
  el.textContent = msg;
}

// ---------- Studenten ----------
function visibleStudentsList() {
  const q = $("#student-search").value.trim().toLowerCase();
  const cohortId = $("#student-cohort").value;
  const classId = $("#student-class-filter").value;
  return students.filter((s) => {
    if (q && !s.name.toLowerCase().includes(q) && !(s.student_number || "").toLowerCase().includes(q)) return false;
    if (classId && String(s.class_id) !== classId) return false;
    if (cohortId) {
      const c = classes.find((x) => x.id === s.class_id);
      if (!c || String(c.cohort_id) !== cohortId) return false;
    }
    return true;
  });
}

function renderStudents() {
  const classOptions = (sel) => `<option value="">Geen klas</option>` +
    classes.map((c) => `<option value="${c.id}"${String(sel) === String(c.id) ? " selected" : ""}>${esc(classLabel(c))}</option>`).join("");
  const classOf = (s) => {
    const c = classes.find((x) => x.id === s.class_id);
    return c ? c.name : "";
  };
  const rows = sortRows(visibleStudentsList(), listSort.students, (s, key) =>
    key === "class" ? classOf(s)
    : (s[key] || ""));
  updateSortArrows("#students-table", listSort.students);
  $("#students-table tbody").innerHTML = pageSlice("#students-table", rows).map((s) => `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="row-select" data-id="${s.id}"></td>
      <td><input data-field="student_number" value="${esc(s.student_number || "")}" style="width:90px"></td>
      <td><input data-field="first_name" value="${esc(s.first_name || "")}" style="width:110px"></td>
      <td><input data-field="prefix" value="${esc(s.prefix || "")}" style="width:80px"></td>
      <td><input data-field="last_name" value="${esc(s.last_name || "")}" style="width:130px"></td>
      <td><input type="email" data-field="email" value="${esc(s.email || "")}" style="width:160px"></td>
      <td><select data-field="class_id">${classOptions(s.class_id)}</select></td>
      <td><button class="secondary" data-archive>Archiveren</button></td>
      ${!currentUser || currentUser.role === "beheerder" ? `<td><button class="danger" data-del>Verwijderen</button></td>` : "<td></td>"}
    </tr>`).join("");
  updateBulkBar();
}

$("#btn-add-student").addEventListener("click", async () => {
  const payload = {
    student_number: $("#student-number").value.trim(),
    first_name: $("#student-firstname").value.trim(),
    prefix: $("#student-prefix").value.trim(),
    last_name: $("#student-lastname").value.trim(),
    email: $("#student-email").value.trim(),
    class_id: $("#student-class").value || null,
  };
  if (!payload.student_number || !payload.first_name || !payload.last_name || !payload.email) {
    return alert("Studentnummer, voornaam, achternaam en e-mailadres zijn verplicht. Tussenvoegsel mag leeg blijven.");
  }
  try {
    await api("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    for (const id of ["student-number", "student-firstname", "student-prefix", "student-lastname", "student-email"]) {
      $("#" + id).value = "";
    }
    await loadAll();
  } catch (err) {
    alert("Student toevoegen mislukt: " + err.message);
  }
});

function selectedStudentIds() {
  return [...$$("#students-table tbody input.row-select:checked")].map((cb) => +cb.dataset.id);
}

function updateBulkBar() {
  const bar = $("#bulk-bar");
  const n = selectedStudentIds().length;
  bar.classList.toggle("hidden", n === 0);
  $("#bulk-count").textContent = n + " geselecteerd";
  $("#bulk-delete").style.display =
    (!currentUser || currentUser.role === "beheerder") ? "" : "none";
}

async function bulkAction(action, confirmMsg) {
  const ids = selectedStudentIds();
  if (!ids.length) return;
  if (confirmMsg && !confirm(confirmMsg.replace("{n}", ids.length))) return;
  try {
    await api("/api/students/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    await loadAll();
  } catch (err) {
    alert("Bulkactie mislukt: " + err.message);
  }
}

$("#bulk-archive").addEventListener("click", () =>
  bulkAction("archive", "{n} studenten archiveren?"));
$("#bulk-delete").addEventListener("click", () =>
  bulkAction("delete", "{n} studenten definitief verwijderen? Dit kan niet ongedaan worden."));

$("#students-select-all").addEventListener("change", (e) => {
  $$("#students-table tbody input.row-select").forEach((cb) => {
    cb.checked = e.target.checked;
  });
  updateBulkBar();
});

$("#students-table tbody").addEventListener("change", async (e) => {
  if (e.target.classList.contains("row-select")) {
    updateBulkBar();
    return;
  }
  const tr = e.target.closest("tr");
  const s = students.find((x) => x.id === +tr.dataset.id);
  if (!s) return;
  const field = e.target.dataset.field;
  if (!field) return;
  const value = e.target.value === "" ? null : e.target.value;
  s[field] = value;
  try {
    await api(`/api/students/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
  await loadAll();
});

// ---------- Klassen ----------
function creboOptions(sel) {
  return `<option value="">Geen crebo</option>` +
    crebos.map((n) => `<option value="${n.id}"${String(sel) === String(n.id) ? " selected" : ""}>${esc(n.name)}</option>`).join("");
}

function optList(sel, items, emptyLabel) {
  let out = `<option value="">${esc(emptyLabel)}</option>`;
  for (const it of items) {
    const mark = String(sel) === String(it.id) ? " selected" : "";
    out += `<option value="${it.id}"${mark}>${esc(it.name)}</option>`;
  }
  return out;
}

function renderCrebos() {
  const q = ($("#crebo-search") ? $("#crebo-search").value : "").trim().toLowerCase();
  const visible = q ? crebos.filter((n) => (n.name || "").toLowerCase().includes(q)) : crebos;
  const rows = sortRows(visible, listSort.crebos, (n, key) => n[key]);
  updateSortArrows("#crebos-table", listSort.crebos);
  const page = pageSlice("#crebos-table", rows);
  $("#crebos-table tbody").innerHTML = page.length ? page.map((n) => `
    <tr data-id="${n.id}">
      <td>${esc(n.name)}</td>
      <td>${isAdmin() ? `<input data-field="sbu_doel" value="${esc(n.sbu_doel ?? 720)}" style="width:90px">` : esc(n.sbu_doel ?? 720)}</td>
      ${isAdmin() ? `<td><button class="danger" data-del>Verwijderen</button></td>` : "<td></td>"}
    </tr>`).join("") : `<tr><td colspan="3" class="hint">${q ? "Niets gevonden voor deze zoekopdracht." : "Nog geen crebos."}</td></tr>`;
}

function renderCohorts() {
  const q = ($("#cohort-search") ? $("#cohort-search").value : "").trim().toLowerCase();
  const visible = q ? cohorts.filter((c) => (c.name || "").toLowerCase().includes(q)) : cohorts;
  const rows = sortRows(visible, listSort.cohorts, (c, key) => c[key]);
  updateSortArrows("#cohorts-table", listSort.cohorts);
  const page = pageSlice("#cohorts-table", rows);
  $("#cohorts-table tbody").innerHTML = page.length ? page.map((c) => `
    <tr data-id="${c.id}">
      <td><input data-field="name" value="${esc(c.name)}"></td>
      ${isAdmin() ? `<td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>` : "<td></td><td></td>"}
    </tr>`).join("") : `<tr><td colspan="3" class="hint">${q ? "Niets gevonden voor deze zoekopdracht." : "Nog geen cohorten."}</td></tr>`;
}

function renderLeertrajecten() {
  const q = ($("#lt-search") ? $("#lt-search").value : "").trim().toLowerCase();
  const visible = q ? leertrajecten.filter((t) =>
    (t.name || "").toLowerCase().includes(q) ||
    (t.crebo || "").toLowerCase().includes(q) ||
    (t.cohort || "").toLowerCase().includes(q)) : leertrajecten;
  const classCount = {};
  classes.forEach((c) => {
    if (c.leertraject_id) classCount[c.leertraject_id] = (classCount[c.leertraject_id] || 0) + 1;
  });
  const rows = sortRows(visible, listSort.leertrajecten, (t, key) =>
    key === "classes_count" ? (classCount[t.id] || 0) : t[key]);
  updateSortArrows("#leertrajecten-table", listSort.leertrajecten);
  refillKeepingValue("#lt-add-crebo", creboOptions(""));
  refillKeepingValue("#lt-add-cohort", optList("", cohorts, "Geen cohort"));
  const page = pageSlice("#leertrajecten-table", rows);
  $("#leertrajecten-table tbody").innerHTML = page.length ? page.map((t) => `
    <tr data-id="${t.id}">
      <td><input data-field="name" value="${esc(t.name)}"></td>
      <td><select data-field="crebo_id">${creboOptions(t.crebo_id)}</select></td>
      <td><select data-field="cohort_id">${optList(t.cohort_id, cohorts, "Geen cohort")}</select></td>
      <td title="Aantal klassen met dit leertraject" class="${(classCount[t.id] || 0) ? "" : "muted"}">${classCount[t.id] || 0}</td>
      ${isAdmin() ? `<td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>` : "<td></td><td></td>"}
    </tr>`).join("") : `<tr><td colspan="6" class="hint">${q ? "Niets gevonden voor deze zoekopdracht." : "Nog geen leertrajecten."}</td></tr>`;
}

function renderClasses() {
  renderCrebos();
  renderCohorts();
  renderLeertrajecten();
  const q = ($("#class-search") ? $("#class-search").value : "").trim().toLowerCase();
  const visible = q ? classes.filter((c) =>
    (c.name || "").toLowerCase().includes(q) ||
    (c.crebo || "").toLowerCase().includes(q) ||
    (c.cohort || "").toLowerCase().includes(q) ||
    (c.mentor || "").toLowerCase().includes(q)) : classes;
  const rows = sortRows(visible, listSort.classes, (c, key) => c[key]);
  updateSortArrows("#classes-table", listSort.classes);
  $("#classes-table tbody").innerHTML = pageSlice("#classes-table", rows).map((c) => `
    <tr data-id="${c.id}">
      <td><input data-field="name" value="${esc(c.name)}"></td>
      <td title="Crebo komt van het leertraject">${esc(c.crebo || "")}</td>
      <td title="Startcohort komt van het leertraject">${esc(c.cohort || "")}</td>
      <td><select data-field="leertraject_id">${ltOptions(c.leertraject_id)}</select></td>
      ${users.length ? `<td><select data-field="mentor_id">${optList(c.mentor_id, users.filter((u) => u.role === "mentor" || u.role === "beheerder").map((u) => ({ id: u.id, name: u.username })), "Geen mentor")}</select></td>` : `<td>${esc(c.mentor || "")}</td>`}
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
  refillKeepingValue("#class-leertraject", ltOptions(""));
}

function refillKeepingValue(sel, html) {
  const el = $(sel);
  if (!el) return;
  const prev = el.value;
  el.innerHTML = html;
  if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
}

$("#btn-add-class").addEventListener("click", async () => {
  const name = $("#class-name").value.trim();
  if (!name) return;
  await api("/api/classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      leertraject_id: $("#class-leertraject").value || null,
    }),
  });
  $("#class-name").value = "";
  await loadAll();
});

$("#btn-add-cohort").addEventListener("click", async () => {
  const name = $("#cohort-name").value.trim();
  if (!name) return alert("Vul eerst een cohortnaam in (bijv. 25-26).");
  try {
    await api("/api/cohorts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    $("#cohort-name").value = "";
    await loadAll();
  } catch (err) {
    alert("Cohort toevoegen mislukt: " + err.message);
  }
});

$("#cohorts-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const field = e.target.dataset.field;
  if (!tr || !field) return;
  const c = cohorts.find((x) => String(x.id) === tr.dataset.id);
  if (!c) return;
  const value = e.target.value.trim();
  if (!value) return alert("Naam mag niet leeg zijn.");
  try {
    await api(`/api/cohorts/${c.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
  await loadAll();
});

$("#cohorts-table tbody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.dataset.archive !== undefined) {
    if (!confirm("Cohort archiveren? Het verdwijnt uit de actieve overzichten; klassen en studenten blijven bewaard.")) return;
    await api(`/api/cohorts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    await loadAll();
  } else if (e.target.dataset.del !== undefined) {
    if (!confirm("Cohort verwijderen? Klassen met dit cohort verliezen hun cohort.")) return;
    await api(`/api/cohorts/${id}`, { method: "DELETE" });
    await loadAll();
  }
});

// ---------- Leertrajecten ----------
function ltLabel(t) {
  const extra = [t.crebo, t.cohort].filter(Boolean).join(", ");
  return extra ? `${t.name} (${extra})` : t.name;
}

function ltOptions(sel) {
  return `<option value="">Geen leertraject</option>` +
    leertrajecten.map((t) => `<option value="${t.id}"${String(sel) === String(t.id) ? " selected" : ""}>${esc(ltLabel(t))}</option>`).join("");
}

$("#btn-add-lt").addEventListener("click", async () => {
  const name = $("#lt-name").value.trim();
  if (!name) return alert("Vul eerst een naam in (bijv. ICT 2-jarig).");
  try {
    await api("/api/leertrajecten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, crebo_id: $("#lt-add-crebo").value || null,
                             cohort_id: $("#lt-add-cohort").value || null }),
    });
    $("#lt-name").value = "";
    $("#lt-add-crebo").value = "";
    $("#lt-add-cohort").value = "";
    await loadAll();
  } catch (err) {
    alert("Leertraject toevoegen mislukt: " + err.message);
  }
});

$("#leertrajecten-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const field = e.target.dataset.field;
  if (!tr || !field) return;
  const t = leertrajecten.find((x) => String(x.id) === tr.dataset.id);
  if (!t) return;
  const value = field === "name" ? e.target.value.trim() : (e.target.value === "" ? null : e.target.value);
  if (field === "name" && !value) return alert("Naam mag niet leeg zijn.");
  try {
    await api(`/api/leertrajecten/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
  await loadAll();
});

$("#leertrajecten-table tbody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.dataset.archive !== undefined) {
    if (!confirm("Leertraject archiveren? Het verdwijnt uit de actieve overzichten; gegevens blijven bewaard.")) return;
    await api(`/api/leertrajecten/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    await loadAll();
  } else if (e.target.dataset.del !== undefined) {
    if (!confirm("Leertraject verwijderen? Klassen met dit leertraject verliezen hun leertraject.")) return;
    await api(`/api/leertrajecten/${id}`, { method: "DELETE" });
    await loadAll();
  }
});

$("#report-class").addEventListener("change", () => renderPeriodSelects());
$("#report-cohort").addEventListener("change", () => renderClassSelects());

$("#btn-add-crebo").addEventListener("click", async () => {
  const name = $("#crebo-name").value.trim();
  if (!name) return;
  await api("/api/crebos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  $("#crebo-name").value = "";
  await loadAll();
});

$("#crebos-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Crebo verwijderen? Leertrajecten met dit crebo verliezen hun crebo.")) return;
  await api(`/api/crebos/${id}`, { method: "DELETE" });
  await loadAll();
});

$("#crebo-search").addEventListener("input", () => { resetPage("#crebos-table"); renderCrebos(); });

$("#crebos-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const field = e.target.dataset.field;
  if (!tr || !field) return;
  const n = crebos.find((x) => String(x.id) === tr.dataset.id);
  if (!n) return;
  try {
    await api(`/api/crebos/${n.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: e.target.value }),
    });
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
  await loadAll();
});
$("#cohort-search").addEventListener("input", () => { resetPage("#cohorts-table"); renderCohorts(); });
$("#lt-search").addEventListener("input", () => { resetPage("#leertrajecten-table"); renderLeertrajecten(); });

$("#classes-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const field = e.target.dataset.field;
  if (!tr || !field) return;
  const c = classes.find((x) => x.id === +tr.dataset.id);
  if (!c) return;
  const value = e.target.value === "" ? null : e.target.value;
  c[field] = value;
  try {
    await api(`/api/classes/${c.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
  await loadAll();
});

$("#classes-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Klas verwijderen? Studenten blijven bestaan maar verliezen hun klas.")) return;
  await api(`/api/classes/${id}`, { method: "DELETE" });
  await loadAll();
});

$("#students-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Student verwijderen? Alle cijfers van deze student vervallen.")) return;
  await api(`/api/students/${id}`, { method: "DELETE" });
  await loadAll();
});

function showResult(sel, res) {
  const el = $(sel);
  el.classList.remove("hidden");
  setResultKind(el, res.errors && res.errors.length);
  let msg = `Toegevoegd: ${res.imported}`;
  if (res.skipped) msg += `, overgeslagen (bestaat al): ${res.skipped}`;
  if (res.errors && res.errors.length) msg += `\nFouten:\n` + res.errors.join("\n");
  el.textContent = msg;
}

// Import studenten via CSV/Excel
$("#import-students-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setImportBusy("#students-import-result", file.name);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("/api/import/students", { method: "POST", body: fd });
    showResult("#students-import-result", res);
    await loadAll();
  } catch (err) {
    showResult("#students-import-result", { imported: 0, errors: [err.message] });
  }
  e.target.value = "";
});

// Import vakken via CSV/Excel
$("#import-subjects-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setImportBusy("#subjects-import-result", file.name);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("/api/import/subjects", { method: "POST", body: fd });
    showResult("#subjects-import-result", res);
    await loadAll();
  } catch (err) {
    showResult("#subjects-import-result", { imported: 0, errors: [err.message] });
  }
  e.target.value = "";
});

// ---------- Vakken ----------
function renderSubjects() {
  const q = $("#subject-filter").value.trim().toLowerCase();
  const vakken = subjects.filter((s) => (s.kind || "vak") === "vak");
  const visible = q ? vakken.filter((s) => s.name.toLowerCase().includes(q)) : vakken;
  const years = {};
  for (const p of periods) {
    const y = p.year || "Zonder studiejaar";
    (years[y] = years[y] || []).push(p);
  }
  const checks = (s) => Object.entries(years).map(([year, mods]) => {
    const anyChecked = mods.some((p) => (s.period_ids || []).includes(p.id));
    return `
      <details class="year-group"${anyChecked ? " open" : ""}>
        <summary>${esc(year)}${anyChecked ? ` <span class="badge">${mods.filter((p) => (s.period_ids || []).includes(p.id)).length}</span>` : ""}</summary>
        <div class="year-modules">${mods.map((p) => `
          <label class="check"><input type="checkbox" data-period="${p.id}"${(s.period_ids || []).includes(p.id) ? " checked" : ""}> ${esc(p.name)}</label>`).join("")}</div>
      </details>`;
  }).join("");
  const rows = sortRows(visible, listSort.subjects, (s, key) => s[key]);
  updateSortArrows("#subjects-table", listSort.subjects);
  $("#subjects-table tbody").innerHTML = pageSlice("#subjects-table", rows).map((s) => `
    <tr data-id="${s.id}">
      <td><input data-field="name" value="${esc(s.name)}"></td>
      <td><select data-field="assessment_type">
        <option value="cijfer"${s.assessment_type === "cijfer" ? " selected" : ""}>Cijfer (1-10)</option>
        <option value="letter"${s.assessment_type === "letter" ? " selected" : ""}>Letter (V/G/O/VS)</option>
        <option value="vnv"${s.assessment_type === "vnv" ? " selected" : ""}>Voldaan / niet voldaan (V/NV)</option>
      </select></td>
      <td class="period-checks">${checks(s)}</td>
      <td></td>
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
}

$("#subject-filter").addEventListener("input", () => { resetPage("#subjects-table"); renderSubjects(); });

$("#btn-add-subject").addEventListener("click", async () => {
  const name = $("#subject-name").value.trim();
  if (!name) return;
  await api("/api/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  $("#subject-name").value = "";
  await loadAll();
});

$("#subjects-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const id = tr.dataset.id;
  if (e.target.dataset.period !== undefined) {
    const periodIds = [...tr.querySelectorAll("input[data-period]:checked")]
      .map((c) => +c.dataset.period);
    try {
      await api(`/api/subjects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_ids: periodIds }),
      });
      const s = subjects.find((x) => x.id === +id);
      if (s) { s.period_ids = periodIds; }
      renderSubjects();
      renderGradeTable();
    } catch (err) {
      alert("Opslaan van koppeling mislukt: " + err.message);
      await loadAll();
    }
  } else if (e.target.dataset.field === "sbu") {
    await api(`/api/subjects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sbu: +e.target.value || 0 }),
    });
    const s = subjects.find((x) => x.id === +id);
    if (s) s.sbu = +e.target.value || 0;
  } else if (e.target.dataset.field === "assessment_type") {
    await api(`/api/subjects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assessment_type: e.target.value }),
    });
    const s = subjects.find((x) => x.id === +id);
    if (s) s.assessment_type = e.target.value;
    renderGradeTable();
  } else {
    await api(`/api/subjects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: e.target.value }),
    });
  }
});

$("#subjects-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Vak verwijderen? Alle cijfers voor dit vak vervallen.")) return;
  await api(`/api/subjects/${id}`, { method: "DELETE" });
  await loadAll();
});

// ---------- Modules ----------
function periodLabel(p) {
  return p.year ? `${p.name} (${p.year})` : p.name;
}

function renderPeriods() {
  const q = ($("#period-search") ? $("#period-search").value : "").trim().toLowerCase();
  const visible = q ? periods.filter((p) =>
    (p.name || "").toLowerCase().includes(q) ||
    (p.year || "").toLowerCase().includes(q)) : periods;
  const rows = sortRows(visible, listSort.periods, (p, key) => p[key]);
  updateSortArrows("#periods-table", listSort.periods);
  $("#periods-table tbody").innerHTML = pageSlice("#periods-table", rows).map((p) => `
    <tr data-id="${p.id}">
      <td><input data-field="name" value="${esc(p.name)}"></td>
      <td><input data-field="year" value="${esc(p.year || "")}"></td>
      <td class="period-checks">${leertrajecten.length ? leertrajecten.map((t) => `
        <label class="check"><input type="checkbox" data-lt="${t.id}"${(p.leertraject_ids || []).includes(t.id) ? " checked" : ""}> ${esc(ltLabel(t))}</label>`).join("") : `<span class="hint">(geen leertrajecten)</span>`}</td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
}

$("#btn-add-period").addEventListener("click", async () => {
  const name = $("#period-name").value.trim();
  if (!name) return;
  await api("/api/periods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, year: $("#period-year").value.trim() }),
  });
  $("#period-name").value = "";
  $("#period-year").value = "";
  await loadAll();
});

$("#periods-table tbody").addEventListener("change", async (e) => {
  if (e.target.dataset.lt !== undefined) {
    const id = e.target.closest("tr").dataset.id;
    const ids = [...e.target.closest("tr").querySelectorAll("input[data-lt]:checked")]
      .map((cb) => +cb.dataset.lt);
    try {
      await api(`/api/periods/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leertraject_ids: ids }),
      });
      const p = periods.find((x) => x.id === +id);
      if (p) p.leertraject_ids = ids;
      renderPeriodSelects();
      renderGradeTable();
    } catch (err) {
      alert("Leertrajecten opslaan mislukt: " + err.message);
    }
    return;
  }
  const id = e.target.closest("tr").dataset.id;
  const p = periods.find((x) => x.id === +id);
  if (!p) return;
  p[e.target.dataset.field] = e.target.value;
  await api(`/api/periods/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  await loadAll();
});

$("#periods-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Module verwijderen? Alle cijfers in deze module vervallen.")) return;
  await api(`/api/periods/${id}`, { method: "DELETE" });
  await loadAll();
});

// ---------- Rapport ----------
$("#btn-report").addEventListener("click", showReport);
$("#btn-print").addEventListener("click", async () => {
  await showReport();
  window.print();
});

async function showReport() {
  const periodId = $("#report-period").value;
  if (!periodId) return;
  if (periodId === "all") {
    const isStudentRole = currentUser && currentUser.role === "student";
    const studentId = isStudentRole ? currentUser.student_id : $("#report-student").value;
    const classId = $("#report-class").value;
    const cohortId = $("#report-cohort").value;
    const audience = isStudentRole ? "student" : $("#report-audience").value;
    if (!isStudentRole && !studentId && !classId) {
      return alert("Kies voor een totaalrapport eerst een student of een klas.");
    }
    const out = $("#report-output");
    out.innerHTML = "";
    for (const p of periods) {
      let url = `/api/report?period_id=${p.id}&audience=${audience}`;
      if (studentId) url += `&student_id=${studentId}`;
      if (classId) url += `&class_id=${classId}`;
      if (!isStudentRole && cohortId) url += `&cohort_id=${cohortId}`;
      const data = await api(url);
      renderReportCards(data, p);
    }
    if (!out.innerHTML) out.innerHTML = `<p class="hint">Er zijn nog geen modules met cijfers.</p>`;
    return;
  }
  const studentId = currentUser && currentUser.role === "student"
    ? currentUser.student_id : $("#report-student").value;
  const classId = $("#report-class").value;
  const cohortId = $("#report-cohort").value;
  const audience = currentUser && currentUser.role === "student"
    ? "student" : $("#report-audience").value;
  let url = `/api/report?period_id=${periodId}&audience=${audience}`;
  if (studentId) url += `&student_id=${studentId}`;
  if (classId) url += `&class_id=${classId}`;
  if (cohortId) url += `&cohort_id=${cohortId}`;
  const data = await api(url);
  const out = $("#report-output");
  out.innerHTML = "";
  renderReportCards(data);
}

function renderReportCards(data, periodOverride) {
  const out = $("#report-output");
  const audience = currentUser && currentUser.role === "student" ? "student" : $("#report-audience").value;
  const moduleLabel = esc(periodLabel(periodOverride || data.period));
  const today = new Date().toLocaleDateString("nl-NL");
  out.innerHTML += (periodOverride ? `<h2 class="report-module-header">Module: ${moduleLabel}</h2>` : "") +
    data.students.map((s) => `
    <div class="report-card">
      <div class="report-head">
        <div class="report-logo">${settings.logo ? `<img src="${esc(settings.logo)}" alt="">` : ""}</div>
        <div class="report-head-text">
          <h2>Rapport</h2>
          <div class="report-school">${esc(settings.school_name || "MBO ICT-opleiding")}</div>
        </div>
        <div class="report-head-module"><strong>Module</strong><br>${moduleLabel}</div>
      </div>
      <table class="report-info">
        <tbody>
          <tr>
            <th>Student</th><td>${esc(s.student.name)}</td>
            <th>Studentnummer</th><td>${esc(s.student.student_number || "")}</td>
          </tr>
          <tr>
            <th>Klas</th><td>${esc(s.class ? s.class.name : "")}</td>
            <th>Crebo</th><td>${esc(s.class && s.class.crebo ? s.class.crebo : "")}</td>
          </tr>
          <tr>
            <th>SLB'er</th><td>${esc(s.class && s.class.mentor ? s.class.mentor : "")}</td>
            <th>Datum</th><td>${today}</td>
          </tr>
          <tr>
            <th>Totaal tekorten</th><td class="${s.total_tekorten > 0 ? "val-onv" : "val-vol"}">${s.total_tekorten}</td>
          </tr>
        </tbody>
      </table>
      ${s.entries.length ? `
      <h3 class="report-section">Beoordelingen</h3>
      <table class="report-grades">
        <thead><tr><th>Vak</th><th>Beoordeling</th></tr></thead>
        <tbody>
          ${s.entries.map((e) => `
          <tr>
            <td>${esc(e.subject)}</td>
            <td class="${e.value === "VS" ? "val-vs" : (e.tekorten > 0 ? "val-onv" : "val-vol")}">${esc(e.value)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<p class="hint report-empty">Geen cijfers bekend in deze module.</p>`}
      ${s.attendance ? `
      <h3 class="report-section">Aanwezigheid</h3>
      <table class="att-table report-att">
        <thead><tr><th>Aanwezigheid</th><th>Geoorloofd afwezig</th><th>Ongeoorloofd afwezig</th></tr></thead>
        <tbody><tr>
          <td class="${s.attendance.present !== null && s.attendance.present !== undefined ? (s.attendance.present >= 85 ? "val-vol" : "val-onv") : ""}">${fmtPct(s.attendance.present)}</td>
          <td class="att-allowed">${fmtPct(s.attendance.absent_allowed)}</td>
          <td class="val-onv">${fmtPct(s.attendance.absent_unallowed)}</td>
        </tr></tbody>
      </table>` : ""}
      ${s.keuzedelen && s.keuzedelen.length ? `
      <h3 class="report-section">Keuzedelen (${s.sbu_total} van ${s.sbu_doel} SBU)</h3>
      <table class="report-grades">
        <thead><tr><th>Keuzedeel</th><th>SBU</th><th>Beoordeling</th></tr></thead>
        <tbody>
          ${s.keuzedelen.map((k) => `
          <tr>
            <td>${esc(k.name)}</td>
            <td>${k.sbu}</td>
            <td class="${k.value ? (k.value === "VS" ? "val-vs" : (k.tekorten > 0 ? "val-onv" : "val-vol")) : ""}">${esc(k.value)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : ""}
      ${s.notes && (s.notes.comment || (audience !== "student" && s.notes.teacher_comment)) ? `
      <h3 class="report-section">Opmerkingen</h3>
      <div class="notes-block">
        ${s.notes.comment ? `<p>${esc(s.notes.comment)}</p>` : ""}
        ${audience !== "student" && s.notes.teacher_comment ? `<p><strong>Opmerking docenten:</strong> ${esc(s.notes.teacher_comment)}</p>` : ""}
      </div>` : ""}
      <div class="report-sign">
        <div class="report-sign-line"></div>
        <div class="report-sign-label">Handtekening SLB'er</div>
        <div class="report-sign-line"></div>
        <div class="report-sign-label">Handtekening student / ouder</div>
      </div>
    </div>`).join("");
}

// ---------- Keuzedelen-matrix ----------
let kdMatrix = null;

async function loadKdMatrix() {
  let url = "/api/keuzedelen/matrix";
  const params = [];
  if ($("#kd-matrix-cohort").value) params.push("cohort_id=" + $("#kd-matrix-cohort").value);
  if ($("#kd-matrix-class").value) params.push("class_id=" + $("#kd-matrix-class").value);
  if (params.length) url += "?" + params.join("&");
  kdMatrix = await api(url);
  renderKdMatrix();
}

function renderKdMatrix() {
  const table = $("#kd-matrix-table");
  if (!kdMatrix) return;
  const q = ($("#kd-matrix-search").value || "").trim().toLowerCase();
  const typeShort = { cijfer: "1-10", letter: "V/G/O/VS", vnv: "V/NV" };
  const mayEdit = isRole("beheerder", "docent", "mentor");
  let rows = kdMatrix.students;
  if (q) {
    rows = rows.filter((s) =>
      studentName(s).toLowerCase().includes(q) ||
      (s.student_number || "").toLowerCase().includes(q) ||
      (s.class_name || "").toLowerCase().includes(q));
  }
  rows = sortRows(rows, listSort.kdmatrix, (s, key) =>
    key === "sbu_total" ? String(s.sbu_total).padStart(4, "0")
    : (s[key] || ""));
  table.querySelector("thead").innerHTML =
    `<tr><th data-key="student_number">Nr.</th><th data-key="first_name">Voornaam</th>` +
    `<th data-key="prefix">Tussenv.</th><th data-key="last_name">Achternaam</th>` +
    `<th data-key="class_name">Klas</th>` +
    kdMatrix.keuzedelen.map((k) =>
      `<th title="Beoordeling: ${typeShort[k.assessment_type] || "1-10"}">${esc(k.name)}</th>`).join("") +
    `<th data-key="sbu_total" title="Totale SBU aan gekoppelde keuzedelen">SBU</th></tr>`;
  updateSortArrows("#kd-matrix-table", listSort.kdmatrix);
  table.querySelector("tbody").innerHTML = pageSlice("#kd-matrix-table", rows).map((s) => {
    const cells = kdMatrix.keuzedelen.map((k) => {
      const linked = k.id in (s.grades || {}) || Object.prototype.hasOwnProperty.call(s.grades || {}, String(k.id));
      const v = (s.grades || {})[String(k.id)] || (s.grades || {})[k.id] || "";
      if (!linked) return `<td class="kd-unlinked" title="Niet gekoppeld">&mdash;</td>`;
      const cls = v && tekorten(v) > 0 ? " val-onv" : (v === "VS" ? " val-vs" : (v ? " val-vol" : ""));
      return `<td><input class="cell${cls}" data-kdm-sid="${s.id}" data-kdm-kid="${k.id}" ` +
        `value="${esc(v)}" placeholder="${typeShort[k.assessment_type] || "1-10"}"${mayEdit ? "" : " disabled"}></td>`;
    }).join("");
    const doel = kdMatrix.sbu_doel;
    return `<tr data-id="${s.id}">
      <td>${esc(s.student_number || "")}</td>
      <td>${esc(s.first_name || "")}</td>
      <td>${esc(s.prefix || "")}</td>
      <td>${esc(s.last_name || "")}</td>
      <td>${esc(s.class_name || "")}</td>
      ${cells}
      <td class="${s.sbu_total >= doel ? "val-vol" : (s.sbu_total > 0 ? "val-onv" : "")}">${s.sbu_total} / ${doel}</td>
    </tr>`;
  }).join("");
}

$("#kd-matrix-table tbody").addEventListener("change", async (e) => {
  const inp = e.target.closest("input[data-kdm-sid]");
  if (!inp) return;
  try {
    await api("/api/keuzedelen/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: +inp.dataset.kdmSid,
        subject_id: +inp.dataset.kdmKid,
        value: inp.value,
      }),
    });
    await loadKdMatrix();
  } catch (err) {
    alert("Keuzedeel opslaan mislukt: " + err.message);
    await loadKdMatrix();
  }
});

for (const sel of ["#kd-matrix-cohort", "#kd-matrix-class"]) {
  $(sel).addEventListener("change", () => { resetPage("#kd-matrix-table"); loadKdMatrix(); });
}
$("#kd-matrix-search").addEventListener("input", () => { resetPage("#kd-matrix-table"); renderKdMatrix(); });

bindTableSort("#kd-matrix-table", "kdmatrix", renderKdMatrix);
bindTableSort("#kd-bulk-table", "kdbulk", renderKdBulk);
bindTableSort("#kd-table", "kdtable", renderKdTable);
$("#kd-search").addEventListener("input", () => { resetPage("#kd-table"); renderKdTable(); });

// ---------- Keuzedelen bulk-koppeling ----------
let kdBulkData = null;

async function loadKdBulk() {
  const params = [];
  if ($("#kd-bulk-cohort").value) params.push("cohort_id=" + $("#kd-bulk-cohort").value);
  if ($("#kd-bulk-class").value) params.push("class_id=" + $("#kd-bulk-class").value);
  kdBulkData = await api("/api/keuzedelen/matrix" + (params.length ? "?" + params.join("&") : ""));
  if (!keuzedelenList.length) await loadKeuzedelenList();
  for (const sel of [$("#kd-bulk-kd"), $("#kd-import-kd")]) {
    const prevKd = sel.value;
    sel.innerHTML = `<option value="">Kies een keuzedeel...</option>` +
      keuzedelenList.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("");
    if (prevKd && [...sel.options].some((o) => o.value === prevKd)) sel.value = prevKd;
  }
  renderKdBulk();
}

function renderKdBulk() {
  if (!kdBulkData) return;
  const kid = $("#kd-bulk-kd").value;
  const q = ($("#kd-bulk-search").value || "").trim().toLowerCase();
  let rows = kdBulkData.students;
  if (q) {
    rows = rows.filter((s) =>
      studentName(s).toLowerCase().includes(q) ||
      (s.student_number || "").toLowerCase().includes(q) ||
      (s.class_name || "").toLowerCase().includes(q));
  }
  const linked = (s) => kid && Object.prototype.hasOwnProperty.call(s.grades || {}, String(kid));
  rows = sortRows(rows, listSort.kdbulk, (s, key) =>
    key === "kd_linked" ? (linked(s) ? "1" : "0")
    : key === "last_name" ? studentName(s)
    : (s[key] || ""));
  updateSortArrows("#kd-bulk-table", listSort.kdbulk);
  $("#kd-bulk-table tbody").innerHTML = pageSlice("#kd-bulk-table", rows).map((s) => `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="kd-bulk-check" data-id="${s.id}"></td>
      <td>${esc(s.student_number || "")}</td>
      <td>${esc(studentName(s))}</td>
      <td>${esc(s.class_name || "")}</td>
      <td>${linked(s) ? `<span class="val-vol" title="Gekoppeld aan dit keuzedeel">&#10003;</span>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="hint">Geen studenten gevonden.</td></tr>`;
}

function kdBulkIds() {
  return [...$$("#kd-bulk-table tbody input.kd-bulk-check:checked")].map((cb) => +cb.dataset.id);
}

async function kdBulkAction(action) {
  const kid = $("#kd-bulk-kd").value;
  if (!kid) return alert("Kies eerst een keuzedeel.");
  const ids = kdBulkIds();
  if (!ids.length) return alert("Vink eerst minimaal \u00e9\u00e9n student aan.");
  const kdName = keuzedelenList.find((k) => k.id === +kid);
  if (!confirm(`${action === "link" ? "Koppel" : "Ontkoppel"} '${kdName ? kdName.name : ""}' aan ${ids.length} student(en)?`)) return;
  try {
    await api("/api/keuzedelen/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject_id: +kid, student_ids: ids, action }),
    });
    await loadKdBulk();
    await loadKdMatrix();
  } catch (err) {
    alert("Bulk-koppeling mislukt: " + err.message);
  }
}

$("#btn-kd-bulk-link").addEventListener("click", () => kdBulkAction("link"));

$("#kd-import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const kid = $("#kd-import-kd").value;
  if (!kid) {
    alert("Kies eerst een keuzedeel.");
    e.target.value = "";
    return;
  }
  setImportBusy("#kd-import-result", file.name);
  const fd = new FormData();
  fd.append("subject_id", kid);
  fd.append("file", file);
  try {
    const res = await api("/api/keuzedelen/import", { method: "POST", body: fd });
    const el = $("#kd-import-result");
    el.classList.remove("hidden");
    setResultKind(el, res.errors && res.errors.length);
    let msg = `Toegevoegd: ${res.imported}`;
    if (res.skipped) msg += `, leeg (gewist): ${res.skipped}`;
    if (res.errors && res.errors.length) msg += "\nFouten:\n" + res.errors.join("\n");
    el.textContent = msg;
    await loadKdMatrix();
    await loadKdBulk();
  } catch (err) {
    const el = $("#kd-import-result");
    el.classList.remove("hidden");
    setResultKind(el, true);
    el.textContent = "Import mislukt: " + err.message;
  }
  e.target.value = "";
});
$("#btn-kd-bulk-unlink").addEventListener("click", () => kdBulkAction("unlink"));
$("#kd-bulk-kd").addEventListener("change", renderKdBulk);
$("#kd-bulk-search").addEventListener("input", () => { resetPage("#kd-bulk-table"); renderKdBulk(); });
for (const sel of ["#kd-bulk-cohort", "#kd-bulk-class"]) {
  $(sel).addEventListener("change", () => { resetPage("#kd-bulk-table"); loadKdBulk(); });
}
$("#kd-bulk-select-all").addEventListener("change", (e) => {
  $$("#kd-bulk-table tbody input.kd-bulk-check").forEach((cb) => { cb.checked = e.target.checked; });
});

// ---------- Keuzedelen ----------
let keuzedelenList = [];   // alle keuzedeel-subjects
let kdStudentData = null;  // data van geselecteerde student

function kdStudentOptions() {
  const q = ($("#kd-student-filter").value || "").trim().toLowerCase();
  const visible = q ? students.filter((s) =>
    studentName(s).toLowerCase().includes(q) ||
    (s.student_number || "").toLowerCase().includes(q)) : students;
  return visible.map((s) =>
    `<option value="${s.id}">${esc(studentName(s))}${s.student_number ? ` (${esc(s.student_number)})` : ""}</option>`).join("");
}

async function loadKeuzedelenList() {
  try {
    keuzedelenList = await api("/api/keuzedelen");
  } catch (err) {
    keuzedelenList = [];
  }
}

async function renderKeuzedelenTab() {
  if (!keuzedelenList.length) await loadKeuzedelenList();
  const sel = $("#kd-student");
  const prev = sel.value;
  sel.innerHTML = kdStudentOptions();
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadKdStudent();
}

async function loadKdStudent() {
  const id = $("#kd-student").value;
  if (!id) { kdStudentData = null; renderKdTable(); return; }
  try {
    kdStudentData = await api(`/api/students/${id}/keuzedelen`);
  } catch (err) {
    kdStudentData = null;
  }
  renderKdTable();
}

function renderKdTable() {
  const mayLink = currentUser && (currentUser.role === "beheerder" || currentUser.role === "mentor");
  const mayGrade = mayLink || (currentUser && currentUser.role === "docent");
  const linked = new Set((kdStudentData && kdStudentData.keuzedelen || []).map((k) => k.subject_id));
  const grades = {};
  (kdStudentData && kdStudentData.keuzedelen || []).forEach((k) => { grades[k.subject_id] = k.grade || ""; });
  const typeShort = { cijfer: "1-10", letter: "V/G/O/VS", vnv: "V/NV" };
  const mayManage = isAdmin();
  const kdDis = mayManage ? "" : " disabled";
  const q = $("#kd-search") ? $("#kd-search").value.trim().toLowerCase() : "";
  let kdRows = keuzedelenList;
  if (q) kdRows = kdRows.filter((k) => (k.name || "").toLowerCase().includes(q));
  kdRows = sortRows(kdRows, listSort.kdtable, (k, key) =>
    key === "linked" ? (linked.has(k.id) ? "1" : "0") : (k[key] ?? ""));
  updateSortArrows("#kd-table", listSort.kdtable);
  $("#kd-table tbody").innerHTML = keuzedelenList.length
    ? pageSlice("#kd-table", kdRows).map((k) => `
      <tr data-id="${k.id}">
        <td><input data-field="name" value="${esc(k.name)}"${kdDis}></td>
        <td><input data-field="sbu" type="number" min="0" value="${k.sbu || 0}" style="width:80px"${kdDis}></td>
        <td><select data-field="assessment_type"${kdDis}>
          <option value="cijfer"${k.assessment_type === "cijfer" ? " selected" : ""}>Cijfer (1-10)</option>
          <option value="letter"${k.assessment_type === "letter" ? " selected" : ""}>Letter (V/G/O/VS)</option>
          <option value="vnv"${k.assessment_type === "vnv" ? " selected" : ""}>Voldaan / niet voldaan (V/NV)</option>
        </select></td>
        <td><input type="checkbox" data-kd-link ${linked.has(k.id) ? " checked" : ""}${mayLink ? "" : " disabled"}></td>
        <td>${linked.has(k.id)
          ? `<input class="cell" data-kd-grade value="${esc(grades[k.id] || "")}" placeholder="${typeShort[k.assessment_type] || "1-10"}"${mayGrade ? "" : " disabled"}>`
          : ""}</td>
        <td>${mayManage ? `<button class="secondary" data-archive>Archiveren</button> <button class="danger" data-del>Verwijderen</button>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="hint">${q ? "Geen keuzedelen gevonden voor deze zoekopdracht." : "Nog geen keuzedelen. Voeg ze hierboven toe."}</td></tr>`;
  const total = kdStudentData ? kdStudentData.sbu_total : 0;
  const doel = kdStudentData ? kdStudentData.sbu_doel : 720;
  const pct = Math.min(100, Math.round(total / doel * 100));
  $("#kd-progress").innerHTML = !kdStudentData ? "" : `
    <div class="kd-progress-info ${total >= doel ? "val-vol" : (total > 0 ? "val-onv" : "")}">
      <strong>${total} van ${doel} SBU</strong> aan keuzedelen gekoppeld
    </div>
    <div class="kd-bar"><div class="kd-bar-fill" style="width:${pct}%"></div></div>`;
}

$("#btn-add-kd").addEventListener("click", async () => {
  const name = $("#kd-name").value.trim();
  const sbu = +$("#kd-sbu").value || 0;
  if (!name) return alert("Vul een naam in voor het keuzedeel.");
  if (!sbu) return alert("Vul de SBU-waarde van het keuzedeel in.");
  try {
    await api("/api/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind: "keuzedeel", sbu,
                             assessment_type: $("#kd-assessment").value }),
    });
    $("#kd-name").value = "";
    $("#kd-sbu").value = "";
    await loadKeuzedelenList();
    renderKdTable();
  } catch (err) {
    alert("Keuzedeel toevoegen mislukt: " + err.message);
  }
});

$("#kd-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  if (!tr || e.target.dataset.field === undefined) return;
  const id = tr.dataset.id;
  const field = e.target.dataset.field;
  const payload = field === "sbu" ? { sbu: +e.target.value || 0 } : { [field]: e.target.value };
  try {
    await api(`/api/subjects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const k = keuzedelenList.find((x) => x.id === +id);
    if (k) {
      if (field === "sbu") k.sbu = +e.target.value || 0;
      else k[field] = e.target.value;
    }
    renderKdTable();
  } catch (err) {
    alert("Keuzedeel opslaan mislukt: " + err.message);
    await loadKeuzedelenList();
    renderKdTable();
  }
});

$("#kd-table tbody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr");
  if (!tr || (e.target.dataset.archive === undefined && e.target.dataset.del === undefined)) return;
  const id = tr.dataset.id;
  if (e.target.dataset.archive !== undefined) {
    if (!confirm("Keuzedeel archiveren? Het verdwijnt uit de actieve lijsten; gegevens blijven bewaard.")) return;
    await api(`/api/subjects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  } else {
    if (!confirm("Keuzedeel verwijderen? Koppelingen en beoordelingen bij studenten vervallen.")) return;
    await api(`/api/subjects/${id}`, { method: "DELETE" });
  }
  await loadKeuzedelenList();
  await loadKdStudent();
});

$("#kd-student").addEventListener("change", loadKdStudent);
$("#kd-student-filter").addEventListener("input", renderKeuzedelenTab);

$("#kd-table tbody").addEventListener("change", async (e) => {
  const sid = $("#kd-student").value;
  if (!sid) return;
  if (e.target.dataset.kdLink !== undefined) {
    const ids = [...$$("#kd-table tbody input[data-kd-link]:checked")]
      .map((cb) => +cb.closest("tr").dataset.id);
    try {
      kdStudentData = await api(`/api/students/${sid}/keuzedelen`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject_ids: ids }),
      });
      renderKdTable();
    } catch (err) {
      alert("Keuzedelen opslaan mislukt: " + err.message);
      await loadKdStudent();
    }
  }
});

$("#kd-table tbody").addEventListener("change", async (e) => {
  if (e.target.dataset.kdGrade === undefined) return;
  const sid = $("#kd-student").value;
  const kid = e.target.closest("tr").dataset.id;
  try {
    kdStudentData = await api(`/api/students/${sid}/keuzedelen`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grades: { [kid]: e.target.value } }),
    });
    renderKdTable();
  } catch (err) {
    alert("Beoordeling opslaan mislukt: " + err.message);
    await loadKdStudent();
  }
});

// ---------- Statistieken ----------
function statPeriodOptions() {
  const y = $("#stat-year") ? $("#stat-year").value : "";
  const list = y ? periods.filter((p) => (p.year || "") === y) : periods;
  return list.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("") +
    `<option value="all">Alle modules</option>`;
}

function bindCombo(inputSel, panelSel, selectSel, itemsFn) {
  const input = $(inputSel), panel = $(panelSel), sel = $(selectSel);
  let active = 0;
  let items = [];

  function labelOf(id) {
    const it = itemsFn("").find((x) => String(x.id) === String(id));
    return it ? it.label : "";
  }

  function render() {
    if (!items.length) {
      panel.innerHTML = `<span class="combo-empty">Geen student gevonden.</span>`;
      return;
    }
    panel.innerHTML = items.map((it, i) =>
      `<span class="combo-item${i === active ? " active" : ""}" data-id="${it.id}">${esc(it.label)}</span>`).join("");
  }

  function open() {
    const q = input.value.trim().toLowerCase();
    items = itemsFn(q);
    active = 0;
    render();
    panel.classList.remove("hidden");
  }

  function close() {
    panel.classList.add("hidden");
  }

  function choose(id, label) {
    sel.value = id;
    input.value = label;
    close();
    sel.dispatchEvent(new Event("change"));
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      sel.value = "";
      sel.dispatchEvent(new Event("change"));
    }
    open();
  });
  input.addEventListener("keydown", (e) => {
    if (panel.classList.contains("hidden")) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) choose(items[active].id, items[active].label);
    } else if (e.key === "Escape") close();
  });
  panel.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".combo-item");
    if (!item) return;
    e.preventDefault();
    choose(item.dataset.id, item.textContent);
  });
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !panel.contains(e.target)) close();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (![...panel.children].some((c) => c.contains(document.activeElement))) {
        input.value = sel.value ? labelOf(sel.value) : "";
      }
    }, 120);
  });
  if (sel.value) input.value = labelOf(sel.value);
}

function statClassOptions() {
  const cohortFilter = $("#stat-cohort") ? $("#stat-cohort").value : "";
  let list = classes;
  if (cohortFilter) {
    list = list.filter((c) => String(c.cohort_id) === cohortFilter);
  }
  if (currentUser && currentUser.role === "mentor") {
    list = list.filter((c) => String(c.mentor_id) === String(currentUser.id));
  }
  return `<option value="">Alle klassen</option>` +
    list.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
}

function statStudentItems(q) {
  const classFilter = $("#stat-class") ? $("#stat-class").value : "";
  const cohortFilter = $("#stat-cohort") ? $("#stat-cohort").value : "";
  const cls = new Map(classes.map((c) => [c.id, c]));
  let list = students;
  if (q) {
    list = list.filter((s) =>
      studentName(s).toLowerCase().includes(q) ||
      (s.student_number || "").toLowerCase().includes(q));
  }
  if (classFilter) {
    list = list.filter((s) => String(s.class_id) === classFilter);
  } else if (cohortFilter) {
    list = list.filter((s) => {
      const c = cls.get(s.class_id);
      return c && String(c.cohort_id) === cohortFilter;
    });
  }
  const items = list.map((s) => {
    const c = s.class_id ? cls.get(s.class_id) : null;
    const label = `${studentName(s)}${s.student_number ? ` (${s.student_number})` : ""}${c ? ` \u2014 ${c.name}` : ""}`;
    return { id: s.id, label };
  }).sort((a, b) => a.label.localeCompare(b.label, "nl"));
  if (!q) items.unshift({ id: "", label: "Alle studenten" });
  return items;
}

function statStudentOptions() {
  const items = statStudentItems("");
  let out = "";
  for (const it of items) {
    out += it.id === ""
      ? `<option value="">${esc(it.label)}</option>`
      : `<option value="${it.id}">${esc(it.label)}</option>`;
  }
  return out;
}

function fillStatFilters() {
  const years = [...new Set(periods.map((p) => p.year || "").filter(Boolean))].sort();
  refillKeepingValue("#stat-year", `<option value="">Alle leerjaren</option>` +
    years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join(""));
  refillKeepingValue("#stat-period", statPeriodOptions());
  refillKeepingValue("#stat-student", statStudentOptions());
  const statTypeInput = $("#stat-student-type");
  if (statTypeInput) {
    const statSelEl = $("#stat-student");
    statTypeInput.value = statSelEl.value
      ? (statStudentItems("").find((x) => String(x.id) === statSelEl.value) || {}).label || ""
      : "";
  }
  refillKeepingValue("#stat-cohort", `<option value="">Alle cohorten</option>` +
    cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(""));
  refillKeepingValue("#stat-class", statClassOptions());
  if (!$("#stat-period").value && periods.length) $("#stat-period").value = periods[0].id;
}

$("#btn-statistics").addEventListener("click", showStatistics);

function renderStatReport(report, data) {
  const pct = (n) => n === null || n === undefined ? "" : `${n}%`;
  let title, table;
  if (report === "detail") {
    const filterTitles = { onvoldoendes: "Onvoldoendes", voldoendes: "Voldoendes", vs: "Vrijstellingen (VS)" };
    title = `${filterTitles[data.filter] || "Beoordelingen"} voor ${data.subject_name}`;
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="${r.tekorten > 0 ? "val-onv" : (r.value === "VS" ? "val-vs" : "val-vol")}">${esc(r.value)}</td>
            <td class="${r.tekorten > 0 ? "val-onv" : ""}">${r.tekorten}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Geen beoordelingen voor dit vak.</p>`;
  } else if (report === "keuzedelen_koppelingen") {
    title = "Gekoppelde studenten per keuzedeel";
    const tot = (rows, key) => rows.reduce((sum, r) => sum + (r[key] || 0), 0);
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Keuzedeel</th><th>SBU</th><th>Studenten</th><th>Beoordeeld</th><th>Voldoendes</th><th>Onvoldoendes</th><th>VS</th><th>Tekorten</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.name)}</td>
            <td>${r.sbu}</td>
            <td>${r.count > 0 ? `<a href="#" class="stat-drill" data-drill="keuzedeel_studenten" data-subject="${r.id}" title="Toon de gekoppelde studenten">${r.count}</a>` : r.count}</td>
            <td>${r.graded}</td>
            <td class="val-vol">${r.vol}</td>
            <td class="${r.onv > 0 ? "val-onv" : ""}">${r.onv}</td>
            <td class="val-vs">${r.vs}</td>
            <td class="${r.tekorten > 0 ? "val-onv" : ""}">${r.tekorten}</td>
          </tr>`).join("")}</tbody>
        <tfoot><tr>
          <td>Totaal (${data.report_rows.length} keuzedelen)</td>
          <td>${tot(data.report_rows, "sbu")}</td>
          <td>${tot(data.report_rows, "count")}</td>
          <td>${tot(data.report_rows, "graded")}</td>
          <td class="val-vol">${tot(data.report_rows, "vol")}</td>
          <td>${tot(data.report_rows, "onv")}</td>
          <td class="val-vs">${tot(data.report_rows, "vs")}</td>
          <td>${tot(data.report_rows, "tekorten")}</td>
        </tr></tfoot>
      </table>` : `<p class="hint">Geen keuzedelen in deze selectie.</p>`;
  } else if (report === "keuzedeel_studenten") {
    title = `Gekoppelde studenten voor ${data.subject_name}`;
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="${r.value ? (r.value === "VS" ? "val-vs" : (r.tekorten > 0 ? "val-onv" : "val-vol")) : ""}">${esc(r.value || "")}</td>
            <td class="${r.tekorten > 0 ? "val-onv" : ""}">${r.tekorten}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Geen studenten gekoppeld aan dit keuzedeel.</p>`;
  } else if (report === "signalering") {
    title = "Signalering";
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>Tekorten</th><th>Aanwezigheid</th><th>SBU keuzedelen</th><th>Signalen</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="${r.tekorten >= (data.thresholds ? data.thresholds.tekortendrempel : 3) ? "val-onv" : ""}">${r.tekorten}</td>
            <td class="${r.present !== null && r.present < (data.thresholds ? data.thresholds.aanwezigheidsgrens : 85) ? "val-onv" : ""}">${pct(r.present)}</td>
            <td class="${r.sbu < (r.sbu_doel || 720) ? "val-onv" : "val-vol"}">${r.sbu} / ${r.sbu_doel || 720}</td>
            <td>${r.reasons.map((x) => esc(x)).join(", ")}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Geen studenten met signalen in deze selectie.</p>`;
  } else if (report === "resultaten") {
    title = "Alle bewaarde resultaten per student";
    table = data.report_rows.length ? data.report_rows.map((r) => `
      <div class="stat-result-student" data-search="${esc((r.student + " " + (r.student_number || "") + " " + (r.class || "")).toLowerCase())}">
      <h3>${esc(r.student)}${r.student_number ? ` (nr. ${esc(r.student_number)})` : ""}${r.class ? ` &mdash; ${esc(r.class)}` : ""}</h3>
      ${r.modules.map((m) => `
        <p class="stat-module-head">${esc(m.period_name)}${m.period_year ? ` (${esc(m.period_year)})` : ""}
          ${m.in_traject ? "" : ` <span class="badge-outside" title="Deze module zit niet in het huidige leertraject van de student">buiten huidig leertraject</span>`}
          ${m.present !== null && m.present !== undefined ? ` &mdash; aanwezigheid ${m.present}%` : ""}
        </p>
        <table class="list">
          <thead><tr><th>Vak</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
          <tbody>${m.entries.map((e) => `
            <tr>
              <td>${esc(e.subject)}</td>
              <td class="${e.tekorten > 0 ? "val-onv" : (e.value === "VS" ? "val-vs" : "val-vol")}">${esc(e.value)}</td>
              <td class="${e.tekorten > 0 ? "val-onv" : ""}">${e.tekorten}</td>
            </tr>`).join("")}</tbody>
        </table>`).join("")}</div>`).join("")
      : `<p class="hint">Geen bewaarde resultaten in deze selectie.</p>`;
  } else if (report === "keuzedelen") {
    title = "Missende keuzedelen (minder SBU gekoppeld dan de Keuzedeel-SBU van het crebo)";
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>SBU gekoppeld</th><th>SBU tekort</th><th>Gekoppelde keuzedelen</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="val-onv">${r.sbu} / ${r.sbu_doel || 720}</td><td class="val-onv">${r.tekort}</td>
            <td>${esc(r.keuzedelen)}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Alle studenten in deze selectie hebben de Keuzedeel-SBU van hun crebo gehaald.</p>`;
  } else if (report === "aanwezigheid") {
    title = "Aanwezigheid onder de norm (<85%)";
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>Aanwezigheid</th><th>Geoorloofd afwezig</th><th>Ongeoorloofd afwezig</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="val-onv">${pct(r.present)}</td>
            <td class="att-allowed">${pct(r.absent_allowed)}</td>
            <td class="val-onv">${pct(r.absent_unallowed)}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Geen studenten onder de aanwezigheidsnorm in deze selectie.</p>`;
  } else {
    title = "Onvoldoendes";
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>Onvoldoende vakken</th><th>Tekorten</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td>${r.fails.map((f) => `${esc(f.subject)} <span class="val-onv">${esc(f.value)}</span>`).join(", ")}</td>
            <td class="val-onv">${r.total_tekorten}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Geen onvoldoendes in deze selectie.</p>`;
  }
  const header = report === "resultaten"
    ? `<h2>${esc(title)}</h2>`
    : `<h2>${esc(title)} — ${esc(periodLabel(data.period))}</h2>`;
  statExportCtx = {
    filename: `statistiek-${report === "detail" ? "beoordelingen" : report || "overzicht"}`,
    sheets: statReportSheets(report, data),
  };
  $("#stat-output").innerHTML = header + table +
    `<p><a href="#" id="stat-back">&larr; Terug naar het overzicht</a></p>`;
  const back = $("#stat-back");
  if (back) back.addEventListener("click", (e) => {
    e.preventDefault();
    $("#stat-report").value = "";
    showStatistics();
  });
  if (report !== "resultaten") enhanceStatReportTable();
  else enhanceStatResultaten();
}

function enhanceStatResultaten() {
  const blocks = $$("#stat-output .stat-result-student");
  if (!blocks.length) return;
  const bar = document.createElement("div");
  bar.className = "toolbar filterbar";
  bar.innerHTML = `<input id="stat-result-search" placeholder="\u2315 Zoek student..." style="margin-left:auto">`;
  const h2 = $("#stat-output h2");
  if (h2) h2.after(bar);
  bar.querySelector("input").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    let visible = 0;
    for (const b of blocks) {
      const show = !q || (b.dataset.search || "").includes(q);
      b.style.display = show ? "" : "none";
      if (show) visible++;
    }
    let empty = $("#stat-output .stat-report-empty");
    if (!visible) {
      if (!empty) {
        empty = document.createElement("p");
        empty.className = "hint stat-report-empty";
        empty.textContent = "Geen studenten gevonden voor deze zoekopdracht.";
        bar.after(empty);
      }
    } else if (empty) empty.remove();
  });
}

// Generieke sortering, filtering en paginering voor de rapporttabellen:
// de tabel die net is gerenderd wordt na afloop verbeterd (klikbare
// kolomkoppen, zoekveld, pager) zonder de rapportinhoud aan te passen.
const statReportTable = { rows: [], q: "", sortIdx: null, dir: 1 };

function enhanceStatReportTable() {
  const table = document.querySelector("#stat-output table.list");
  if (!table || !table.tBodies.length) return;
  table.id = "stat-report-table";
  table.classList.add("stat-report-sortable");
  statReportTable.rows = [...table.tBodies[0].rows];
  if (!statReportTable.rows.length) return;
  statReportTable.q = "";
  statReportTable.sortIdx = null;
  statReportTable.dir = 1;
  const bar = document.createElement("div");
  bar.className = "toolbar filterbar";
  bar.innerHTML = `<input id="stat-report-search" placeholder="\u2315 Zoeken in dit rapport..." style="margin-left:auto">`;
  table.before(bar);
  const pager = document.createElement("div");
  pager.className = "pager";
  pager.dataset.table = "stat-report-table";
  table.after(pager);
  bar.querySelector("input").addEventListener("input", (e) => {
    statReportTable.q = e.target.value.trim().toLowerCase();
    resetPage("#stat-report-table");
    applyStatReportTable();
  });
  table.tHead.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th) return;
    const idx = [...table.tHead.rows[0].cells].indexOf(th);
    if (idx < 0) return;
    if (statReportTable.sortIdx === idx) statReportTable.dir *= -1;
    else { statReportTable.sortIdx = idx; statReportTable.dir = 1; }
    applyStatReportTable();
  });
  applyStatReportTable();
}

function applyStatReportTable() {
  const state = statReportTable;
  const table = $("#stat-report-table");
  if (!table) return;
  let list = state.rows;
  if (state.q) list = list.filter((r) => r.textContent.toLowerCase().includes(state.q));
  if (state.sortIdx !== null) {
    const idx = state.sortIdx, dir = state.dir;
    const cellVal = (r) => (r.cells[idx] ? r.cells[idx].textContent.trim() : "");
    const asNum = (t) => { const n = parseFloat(t.replace(",", ".")); return t !== "" && !isNaN(n) ? n : null; };
    list = [...list].sort((a, b) => {
      const ta = cellVal(a), tb = cellVal(b);
      const na = asNum(ta), nb = asNum(tb);
      if (na !== null && nb !== null) return (na - nb) * dir;
      return (ta.toLowerCase() < tb.toLowerCase() ? -1 : ta.toLowerCase() > tb.toLowerCase() ? 1 : 0) * dir;
    });
  }
  [...table.tHead.rows[0].cells].forEach((th, i) => {
    const active = i === state.sortIdx;
    th.classList.toggle("stat-sorted-asc", active && state.dir === 1);
    th.classList.toggle("stat-sorted-desc", active && state.dir === -1);
    th.title = active
      ? `Gesorteerd op deze kolom (${state.dir === 1 ? "oplopend" : "aflopend"})`
      : "Sorteren op deze kolom";
  });
  const empty = table.parentElement.querySelector(".stat-report-empty");
  if (empty) empty.remove();
  const page = pageSlice("#stat-report-table", list);
  table.tBodies[0].replaceChildren(...page);
  if (!list.length && state.rows.length) {
    const p = document.createElement("p");
    p.className = "hint stat-report-empty";
    p.textContent = "Geen rijen gevonden voor deze zoekopdracht.";
    table.parentElement.insertBefore(p, table.nextSibling);
  }
}

document.addEventListener("click", async (e) => {
  const link = e.target.closest(".stat-drill");
  if (!link) return;
  e.preventDefault();
  const kind = link.dataset.drill;
  const periodId = $("#stat-period").value;
  if (!periodId) return;
  let url = `/api/statistics?period_id=${periodId}&report=${kind}`;
  if (link.dataset.subject) url += `&subject_id=${link.dataset.subject}`;
  if (link.dataset.class) url += `&class_id=${link.dataset.class}`;
  if (link.dataset.filter) url += `&filter=${link.dataset.filter}`;
  if ($("#stat-cohort").value) url += `&cohort_id=${$("#stat-cohort").value}`;
  if ($("#stat-year").value) url += `&year=${encodeURIComponent($("#stat-year").value)}`;
  if ($("#stat-student") && $("#stat-student").value) url += `&student_id=${$("#stat-student").value}`;
  try {
    const data = await api(url);
    renderStatReport(kind, data);
  } catch (err) {
    alert("Detailgegevens ophalen mislukt: " + err.message);
  }
});

let statData = null;
let statExportCtx = null;
const statSort = {};

// ---------- Grafieken (inline SVG) ----------
function statVakChart(subjects) {
  const rows = subjects.filter((s) => s.count > 0);
  if (!rows.length) return "";
  const max = Math.max(...rows.map((s) => s.vol + s.onv + s.vs), 1);
  const labelW = 170, barW = 230, rowH = 22;
  const w = labelW + barW + 48;
  let bars = "";
  rows.forEach((s, i) => {
    const y = i * rowH;
    let x = labelW;
    let segs = "";
    for (const [cls, v] of [["vol", s.vol], ["onv", s.onv], ["vs", s.vs]]) {
      if (!v) continue;
      const sw = Math.max((v / max) * barW, v > 0 ? 1 : 0);
      segs += `<rect x="${x.toFixed(1)}" y="${y + 5}" width="${sw.toFixed(1)}" height="11" class="chart-seg ${cls}"/>`;
      x += sw;
    }
    bars += `<text x="${labelW - 6}" y="${y + 14}" class="chart-label" text-anchor="end">${esc(s.name.length > 24 ? s.name.slice(0, 23) + "\u2026" : s.name)}</text>${segs}<text x="${x + 6}" y="${y + 14}" class="chart-value">${s.count}</text>`;
  });
  const h = rows.length * rowH;
  return `<div class="chart-block"><h3>Beoordelingen per vak</h3>
    <svg class="stat-chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gestapelde balken per vak: voldoendes, onvoldoendes en vrijstellingen">${bars}</svg>
    <p class="chart-legend"><span class="legend-swatch legend-vol"></span> voldoende <span class="legend-swatch legend-onv"></span> onvoldoende <span class="legend-swatch legend-vs"></span> vrijstelling (VS)</p>
  </div>`;
}

function statClassChart(classes) {
  const rows = classes.filter((c) => c.avg !== null && c.avg !== undefined);
  if (rows.length < 2) return "";
  const chartH = 150, barW = 34, gap = 16, axisPad = 28, labelH = 30;
  const w = axisPad + rows.length * (barW + gap);
  const h = chartH + labelH;
  const normY = chartH - (6 / 10) * chartH;
  let bars = `<line x1="${axisPad - 4}" y1="${normY}" x2="${w}" y2="${normY}" class="chart-norm"/><text x="${axisPad - 6}" y="${normY + 4}" class="chart-axis" text-anchor="end">6</text>`;
  rows.forEach((c, i) => {
    const x = axisPad + i * (barW + gap);
    const bh = Math.max((c.avg / 10) * chartH, 1);
    const y = chartH - bh;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${bh.toFixed(1)}" class="chart-bar${c.avg < 6 ? " bar-onv" : ""}"/>` +
      `<text x="${x + barW / 2}" y="${y - 4}" class="chart-value" text-anchor="middle">${String(c.avg).replace(".", ",")}</text>` +
      `<text x="${x + barW / 2}" y="${chartH + 16}" class="chart-label" text-anchor="middle">${esc(c.class.length > 10 ? c.class.slice(0, 9) + "\u2026" : c.class)}</text>` +
      `<text x="${x + barW / 2}" y="${chartH + 28}" class="chart-axis" text-anchor="middle">${c.tekorten} tk</text>`;
  });
  return `<div class="chart-block"><h3>Gemiddeld cijfer per klas</h3>
    <svg class="stat-chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gemiddeld cijfer per klas, stippellijn op 6 is de voldoende-grens">${bars}</svg>
    <p class="chart-legend">Stippellijn = voldoende-grens (6); onder elke klas staat het aantal tekorten (tk).</p>
  </div>`;
}

// ---------- Excel-export van wat in beeld is ----------
function statOverviewSheets(data) {
  const sheets = [];
  if (data.subjects.length) {
    const allModules = data.period.name === "Alle modules";
    sheets.push({
      name: "Vakken",
      headers: ["Vak", ...(allModules ? ["Module(s)"] : []), "Beoordelingen", "Gemiddeld cijfer", "Voldoendes", "Onvoldoendes", "VS", "Tekorten"],
      rows: data.subjects.map((s) => [s.name, ...(allModules ? [s.modules || ""] : []), s.count, s.avg, s.vol, s.onv, s.vs, s.tekorten]),
      widths: [30, ...(allModules ? [24] : []), 14, 16, 12, 14, 8, 10],
    });
  }
  if (data.classes.length) {
    sheets.push({
      name: "Klassen",
      headers: ["Klas", "Studenten", "Gemiddeld cijfer", "Tekorten", "Tekort per student", "% voldoende", "Gem. aanwezigheid", "Aanwezig onder norm"],
      rows: data.classes.map((c) => [c.class, c.students, c.avg, c.tekorten, c.tekort_per_student, c.vol_pct, c.attendance_avg, c.attendance_low]),
      widths: [22, 11, 16, 10, 17, 13, 17, 19],
    });
  }
  if (data.signals.length) {
    sheets.push({
      name: "Signalering",
      headers: ["Student", "Nr.", "Klas", "Tekorten (module)", "Aanwezigheid", "SBU keuzedelen", "SBU-doel", "Signalen"],
      rows: data.signals.map((s) => [s.student, s.student_number, s.class, s.tekorten, s.present, s.sbu, s.sbu_doel, s.reasons.join(", ")]),
      widths: [28, 10, 14, 16, 14, 15, 10, 40],
    });
  }
  return sheets;
}

function statReportSheets(report, data) {
  const rows = data.report_rows || [];
  if (report === "detail") {
    return [{ name: "Beoordelingen", headers: ["Student", "Nr.", "Klas", "Beoordeling", "Tekorten"],
      rows: rows.map((r) => [r.student, r.student_number, r.class, r.value, r.tekorten]), widths: [28, 10, 14, 12, 10] }];
  }
  if (report === "keuzedelen_koppelingen") {
    return [{ name: "Keuzedelen", headers: ["Keuzedeel", "SBU", "Studenten", "Beoordeeld", "Voldoendes", "Onvoldoendes", "VS", "Tekorten"],
      rows: rows.map((r) => [r.name, r.sbu, r.count, r.graded, r.vol, r.onv, r.vs, r.tekorten]), widths: [34, 8, 11, 12, 12, 14, 6, 10] }];
  }
  if (report === "keuzedeel_studenten") {
    return [{ name: "Studenten", headers: ["Student", "Nr.", "Klas", "Beoordeling", "Tekorten"],
      rows: rows.map((r) => [r.student, r.student_number, r.class, r.value, r.tekorten]), widths: [28, 10, 14, 12, 10] }];
  }
  if (report === "signalering") {
    return [{ name: "Signalering", headers: ["Student", "Nr.", "Klas", "Tekorten", "Aanwezigheid", "SBU keuzedelen", "SBU-doel", "Signalen"],
      rows: rows.map((r) => [r.student, r.student_number, r.class, r.tekorten, r.present, r.sbu, r.sbu_doel, r.reasons.join(", ")]), widths: [28, 10, 14, 10, 14, 15, 10, 40] }];
  }
  if (report === "resultaten") {
    const flat = [];
    for (const r of rows) for (const m of r.modules || []) for (const e of m.entries || []) {
      flat.push([r.student, r.student_number, r.class, m.period_name, m.period_year, m.in_traject ? "ja" : "nee", m.present, e.subject, e.value, e.tekorten]);
    }
    return [{ name: "Resultaten", headers: ["Student", "Nr.", "Klas", "Module", "Leerjaar", "In leertraject", "Aanwezigheid", "Vak", "Beoordeling", "Tekorten"],
      rows: flat, widths: [28, 10, 14, 16, 10, 13, 14, 26, 12, 10] }];
  }
  if (report === "keuzedelen") {
    return [{ name: "Missende keuzedelen", headers: ["Student", "Nr.", "Klas", "SBU gekoppeld", "SBU-doel", "SBU tekort", "Gekoppelde keuzedelen"],
      rows: rows.map((r) => [r.student, r.student_number, r.class, r.sbu, r.sbu_doel, r.tekort, r.keuzedelen]), widths: [28, 10, 14, 14, 10, 11, 40] }];
  }
  if (report === "aanwezigheid") {
    return [{ name: "Aanwezigheid", headers: ["Student", "Nr.", "Klas", "Aanwezigheid", "Geoorloofd afwezig", "Ongeoorloofd afwezig"],
      rows: rows.map((r) => [r.student, r.student_number, r.class, r.present, r.absent_allowed, r.absent_unallowed]), widths: [28, 10, 14, 14, 18, 20] }];
  }
  return [{ name: "Onvoldoendes", headers: ["Student", "Nr.", "Klas", "Onvoldoende vakken", "Tekorten"],
    rows: rows.map((r) => [r.student, r.student_number, r.class, r.fails.map((f) => `${f.subject}: ${f.value}`).join(", "), r.total_tekorten]), widths: [28, 10, 14, 40, 10] }];
}

async function exportStatExcel() {
  if (!statExportCtx || !statExportCtx.sheets.length) {
    alert("Bereken eerst statistieken; er is nog niets om te exporteren.");
    return;
  }
  const btn = $("#btn-stat-export");
  if (btn) { btn.disabled = true; btn.textContent = "Bezig\u2026"; }
  try {
    const res = await fetch("/api/statistics/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: statExportCtx.filename, sheets: statExportCtx.sheets }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${statExportCtx.filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    alert("Export mislukt: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Export Excel"; }
  }
}

$("#btn-stat-export").addEventListener("click", exportStatExcel);

function statTh(tableId, key, label) {
  const st = statSort[tableId];
  const active = st && st.key === key;
  const mark = active ? (st.dir === 1 ? "\u25BE" : "\u25B4") : "\u21C5";
  return `<th data-stat-table="${tableId}" data-stat-key="${key}" title="Sorteren op ${esc(label)}">${label} <span class="sort-indicator${active ? " active" : ""}">${mark}</span></th>`;
}

function statSortRows(tableId, rows) {
  const st = statSort[tableId];
  if (!st || !st.key) return rows;
  const dir = st.dir;
  return [...rows].sort((a, b) => {
    let av = a[st.key], bv = b[st.key];
    if (av === null || av === undefined) av = -Infinity;
    if (bv === null || bv === undefined) bv = -Infinity;
    if (typeof av === "number" || typeof bv === "number") {
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    }
    const as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
    return as < bs ? -dir : as > bs ? dir : 0;
  });
}

async function showStatistics() {
  const periodId = $("#stat-period").value;
  if (!periodId) return;
  let url = `/api/statistics?period_id=${periodId}`;
  if ($("#stat-cohort").value) url += `&cohort_id=${$("#stat-cohort").value}`;
  if ($("#stat-class").value) url += `&class_id=${$("#stat-class").value}`;
  if ($("#stat-year").value) url += `&year=${encodeURIComponent($("#stat-year").value)}`;
  if ($("#stat-student") && $("#stat-student").value) url += `&student_id=${$("#stat-student").value}`;
  const report = $("#stat-report").value;
  if (report) url += `&report=${report}`;
  const data = await api(url);
  if (data.report_rows !== undefined) {
    statData = null;
    renderStatReport(report, data);
    return;
  }
  statData = data;
  renderStatOverview();
}

function renderStatOverview() {
  const data = statData;
  if (!data) return;
  const pct = (n) => n === null || n === undefined ? "" : `${n}%`;
  const avg = (n) => n === null || n === undefined ? "" : String(n).replace(".", ",");
  const th = data.thresholds || { tekortendrempel: 3, aanwezigheidsgrens: 85 };
  const subjects = pageSlice("#stat-subjects-table", statSortRows("stat-subjects-table", data.subjects));
  const signals = pageSlice("#stat-signals-table", statSortRows("stat-signals-table", data.signals));
  const classes = pageSlice("#stat-classes-table", statSortRows("stat-classes-table", data.classes));
  const vakChart = statVakChart(data.subjects);
  const classChart = statClassChart(data.classes);
  statExportCtx = { filename: "statistiek-overzicht", sheets: statOverviewSheets(data) };
  let html = `<h2>Statistieken — ${esc(periodLabel(data.period))}</h2>`;
  // Vakken
  html += `<h3>Vakken</h3>` + (data.subjects.length ? `
    <table class="list sortable" id="stat-subjects-table">
      <thead><tr>${statTh("stat-subjects-table", "name", "Vak")}${data.period.name === "Alle modules" ? statTh("stat-subjects-table", "modules", "Module(s)") : ""}${statTh("stat-subjects-table", "count", "Beoordelingen")}${statTh("stat-subjects-table", "avg", "Gemiddeld cijfer")}${statTh("stat-subjects-table", "vol", "Voldoendes")}${statTh("stat-subjects-table", "onv", "Onvoldoendes")}${statTh("stat-subjects-table", "vs", "VS")}${statTh("stat-subjects-table", "tekorten", "Tekorten")}</tr></thead>
      <tbody>${subjects.map((s) => `
        <tr>
          <td><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" title="Toon alle beoordelingen voor dit vak">${esc(s.name)}</a></td>
          ${data.period.name === "Alle modules" ? `<td>${esc(s.modules || "")}</td>` : ""}
          <td><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" title="Toon alle beoordelingen voor dit vak">${s.count}</a></td><td>${avg(s.avg)}</td>
          <td class="val-vol"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="voldoendes" title="Toon de voldoendes voor dit vak">${s.vol}</a></td>
          <td class="${s.onv > 0 ? "val-onv" : ""}"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="onvoldoendes" title="Toon de onvoldoendes voor dit vak">${s.onv}</a></td>
          <td class="val-vs"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="vs" title="Toon de vrijstellingen voor dit vak">${s.vs}</a></td>
          <td class="${s.tekorten > 0 ? "val-onv" : ""}"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="onvoldoendes" title="Toon de onvoldoendes voor dit vak">${s.tekorten}</a></td>
        </tr>`).join("")}</tbody>
    </table><div class="pager" data-table="stat-subjects-table"></div>${vakChart}` : `<p class="hint">Geen vakken met cijfers in deze module.</p>`);
  // Klassen-vergelijking
  if (data.classes.length > 1) {
    html += `<h3>Klassen-vergelijking</h3>
    <table class="list sortable" id="stat-classes-table">
      <thead><tr>${statTh("stat-classes-table", "class", "Klas")}${statTh("stat-classes-table", "students", "Studenten")}${statTh("stat-classes-table", "avg", "Gemiddeld cijfer")}${statTh("stat-classes-table", "tekorten", "Tekorten")}${statTh("stat-classes-table", "tekort_per_student", "Tekort per student")}${statTh("stat-classes-table", "vol_pct", "% voldoende")}${statTh("stat-classes-table", "attendance_avg", "Gem. aanwezigheid")}${statTh("stat-classes-table", "attendance_low", "Aanwezig onder norm")}</tr></thead>
      <tbody>${classes.map((c) => `
        <tr>
          <td><a href="#" class="stat-drill" data-drill="onvoldoendes" data-class="${c.class_id}" title="Toon de onvoldoendes in deze klas">${esc(c.class)}</a></td><td>${c.students}</td><td>${avg(c.avg)}</td>
          <td class="${c.tekorten > 0 ? "val-onv" : ""}">${c.tekorten > 0 ? `<a href="#" class="stat-drill" data-drill="onvoldoendes" data-class="${c.class_id}" title="Toon de tekorten en onvoldoendes in deze klas">${c.tekorten}</a>` : c.tekorten}</td>
          <td>${String(c.tekort_per_student).replace(".", ",")}</td>
          <td>${c.vol_pct === null ? "" : c.vol_pct + "%"}</td>
          <td class="${c.attendance_avg !== null && c.attendance_avg < th.aanwezigheidsgrens ? "val-onv" : "val-vol"}">${pct(c.attendance_avg)}</td>
          <td class="${c.attendance_low > 0 ? "val-onv" : ""}">${c.attendance_low > 0 ? `<a href="#" class="stat-drill" data-drill="aanwezigheid" data-class="${c.class_id}" title="Toon deze studenten">${c.attendance_low}</a>` : c.attendance_low}</td>
        </tr>`).join("")}</tbody>
    </table><div class="pager" data-table="stat-classes-table"></div>${classChart}`;
  }
  // Signalering
  html += `<h3>Signalering</h3>` + (data.signals.length ? `
    <table class="list sortable" id="stat-signals-table">
      <thead><tr>${statTh("stat-signals-table", "student", "Student")}${statTh("stat-signals-table", "student_number", "Nr.")}${statTh("stat-signals-table", "class", "Klas")}${statTh("stat-signals-table", "tekorten", "Tekorten (module)")}${statTh("stat-signals-table", "present", "Aanwezigheid")}${statTh("stat-signals-table", "sbu", "SBU keuzedelen")}${statTh("stat-signals-table", "reasons", "Signalen")}</tr></thead>
      <tbody>${signals.map((s) => `
        <tr>
          <td>${esc(s.student)}</td><td>${esc(s.student_number || "")}</td><td>${esc(s.class)}</td>
          <td class="${s.tekorten >= th.tekortendrempel ? "val-onv" : ""}">${s.tekorten}</td>
          <td class="${s.present !== null && s.present < th.aanwezigheidsgrens ? "val-onv" : ""}">${pct(s.present)}</td>
          <td class="${s.sbu < (s.sbu_doel || 720) ? "val-onv" : "val-vol"}">${s.sbu} / ${s.sbu_doel || 720}</td>
          <td>${s.reasons.map((r) => esc(r)).join(", ")}</td>
        </tr>`).join("")}</tbody>
    </table><div class="pager" data-table="stat-signals-table"></div>` : `<p class="hint">Geen studenten met signalen in deze selectie.</p>`);
  $("#stat-output").innerHTML = html;
}

$("#stat-output").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-stat-key]");
  if (!th) return;
  const t = th.dataset.statTable, k = th.dataset.statKey;
  const st = statSort[t] || (statSort[t] = { key: null, dir: 1 });
  if (st.key === k) st.dir = st.dir === 1 ? -1 : 1;
  else { st.key = k; st.dir = 1; }
  renderStatOverview();
});

$("#stat-year").addEventListener("change", () => {
  refillKeepingValue("#stat-period", statPeriodOptions());
});

for (const sel of ["#stat-cohort", "#stat-class"]) {
  $(sel).addEventListener("change", () => {
    refillKeepingValue("#stat-student", statStudentOptions());
  });
}

function reportStudentItems(q) {
  let list = students;
  if (q) {
    list = list.filter((s) =>
      studentName(s).toLowerCase().includes(q) ||
      (s.student_number || "").toLowerCase().includes(q));
  }
  const items = list.map((s) => ({
    id: s.id,
    label: `${studentName(s)}${s.student_number ? ` (${s.student_number})` : ""}`,
  })).sort((a, b) => a.label.localeCompare(b.label, "nl"));
  if (!q) items.unshift({ id: "", label: "Alle studenten" });
  return items;
}

bindCombo("#stat-student-type", "#stat-student-panel", "#stat-student", statStudentItems);
bindCombo("#report-student-type", "#report-student-panel", "#report-student", reportStudentItems);

$("#stat-cohort").addEventListener("change", () => {
  refillKeepingValue("#stat-class", statClassOptions());
  const sc = $("#stat-class");
  if (sc.value && ![...sc.options].some((o) => o.value === sc.value)) sc.value = "";
  refillKeepingValue("#stat-student", statStudentOptions());
  const typeInput = $("#stat-student-type");
  if (typeInput && !$("#stat-student").value) typeInput.value = "";
});

$("#stat-class").addEventListener("change", () => {
  refillKeepingValue("#stat-student", statStudentOptions());
  const typeInput = $("#stat-student-type");
  if (typeInput && !$("#stat-student").value) typeInput.value = "";
});

// ---------- Vergadering (rapportvergaderingen) ----------
let meetingsList = [];
let meetingDetail = null;   // detail van de geopende vergadering
let beamerIndex = 0;        // actieve student in de beamermodus

function meetingClassOptions() {
  let list = ownClassesOnly(classes);
  return list.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
}

function meetingPeriodOptions() {
  return periods.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("");
}

function refillMeetingSelects() {
  refillKeepingValue("#meeting-class", meetingClassOptions());
  refillKeepingValue("#meeting-period", meetingPeriodOptions());
  const d = $("#meeting-date");
  if (!d.value) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    d.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}

async function renderMeetingsTab() {
  refillMeetingSelects();
  await loadMeetings();
}

async function loadMeetings() {
  try {
    meetingsList = await api("/api/meetings");
  } catch (err) {
    meetingsList = [];
  }
  renderMeetingsTable();
}

function renderMeetingsTable() {
  const q = ($("#meeting-search").value || "").trim().toLowerCase();
  let rows = meetingsList;
  if (q) {
    rows = rows.filter((m) =>
      (m.class_name || "").toLowerCase().includes(q) ||
      (m.period_name || "").toLowerCase().includes(q) ||
      (m.meeting_date || "").includes(q) ||
      (m.status || "").toLowerCase().includes(q));
  }
  rows = sortRows(rows, listSort.meetings, (m, key) => m[key] ?? "");
  updateSortArrows("#meetings-table", listSort.meetings);
  const mayManage = isRole("beheerder", "mentor", "docent");
  $("#meetings-table tbody").innerHTML = rows.length
    ? pageSlice("#meetings-table", rows).map((m) => `
      <tr data-id="${m.id}">
        <td><a href="#" class="meeting-open">${esc(m.meeting_date)}</a></td>
        <td>${esc(m.class_name)}</td>
        <td>${esc(periodLabel({ name: m.period_name, year: m.period_year }))}</td>
        <td>${m.items}</td>
        <td class="${m.followups > 0 ? "val-geel" : ""}">${m.followups}</td>
        <td>${m.status === "afgerond" ? `<span class="badge-done">afgerond</span>` : `<span class="badge-open">open</span>`}</td>
        <td>${mayManage ? `<button class="danger meeting-del" title="Vergadering verwijderen">Verwijderen</button>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="hint">Nog geen vergaderingen. Maak er hierboven een aan.</td></tr>`;
}

bindTableSort("#meetings-table", "meetings", renderMeetingsTable);
$("#meeting-search").addEventListener("input", () => { resetPage("#meetings-table"); renderMeetingsTable(); });

$("#btn-meeting-new").addEventListener("click", async () => {
  const classId = $("#meeting-class").value;
  const periodId = $("#meeting-period").value;
  if (!classId || !periodId) return alert("Kies een klas en een module.");
  const meetingDate = $("#meeting-date").value;
  try {
    const res = await api("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ class_id: +classId, period_id: +periodId,
                             meeting_date: meetingDate,
                             include_sbu: $("#meeting-include-sbu").checked }),
    });
    await loadMeetings();
    await openMeeting(res.id);
  } catch (err) {
    alert("Vergadering aanmaken mislukt: " + err.message);
  }
});

$("#meetings-table tbody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = +tr.dataset.id;
  if (e.target.closest(".meeting-del")) {
    if (!confirm("Deze vergadering verwijderen?")) return;
    try {
      await api(`/api/meetings/${id}`, { method: "DELETE" });
      if (meetingDetail && meetingDetail.meeting.id === id) {
        meetingDetail = null;
        $("#meeting-detail").innerHTML = "";
      }
      await loadMeetings();
    } catch (err) {
      alert("Verwijderen mislukt: " + err.message);
    }
    return;
  }
  if (e.target.closest(".meeting-open")) {
    e.preventDefault();
    await openMeeting(id);
  }
});

async function openMeeting(id) {
  try {
    meetingDetail = await api(`/api/meetings/${id}`);
  } catch (err) {
    alert("Vergadering openen mislukt: " + err.message);
    return;
  }
  renderMeetingDetail();
}

function meetingStatusLabel(m) {
  return m.status === "afgerond" ? `<span class="badge-done">afgerond</span>` : `<span class="badge-open">open</span>`;
}

function renderMeetingDetail() {
  const d = meetingDetail;
  if (!d) return;
  const m = d.meeting;
  const mayManage = isRole("beheerder", "mentor", "docent");
  const classStudents = students.filter((s) => String(s.class_id) === String(m.class_id));
  const onList = new Set(d.items.map((i) => i.student_id));
  const addable = classStudents.filter((s) => !onList.has(s.id));
  let html = `<div class="meeting-detail-card">
    <div class="toolbar">
      <h2 style="margin:0">Vergadering ${esc(m.class_name)} — ${esc(periodLabel({ name: m.period_name, year: m.period_year }))}</h2>
      <span class="meeting-date">${esc(m.meeting_date)}</span>
      ${m.include_sbu ? "" : `<span class="badge-sbu-off" title="SBU-tekort bij keuzedelen is voor deze vergadering niet als signaal meegenomen">geen SBU-signaal</span>`}
      ${meetingStatusLabel(m)}
      <span class="push-right"></span>
      ${mayManage ? `<button id="btn-beamer" class="primary">Beamermodus</button>` : ""}
      <button id="btn-meeting-print" class="secondary">Verslag afdrukken</button>
      ${mayManage ? (m.status === "open"
        ? `<button id="btn-meeting-close" class="secondary">Afsluiten</button>`
        : `<button id="btn-meeting-reopen" class="secondary">Heropenen</button>`) : ""}
      <button id="btn-meeting-back" class="secondary">Terug</button>
    </div>
    ${mayManage ? `
    <div class="toolbar subtoolbar">
      <strong>Student toevoegen:</strong>
      <select id="meeting-add-student">${addable.map((s) =>
        `<option value="${s.id}">${esc(studentName(s))}${s.student_number ? ` (${esc(s.student_number)})` : ""}</option>`).join("")}</select>
      <input id="meeting-add-reason" placeholder="Reden (bijv. aandachtspunt)" style="max-width:260px">
      <button id="btn-meeting-add">Toevoegen</button>
    </div>` : ""}
    ${d.items.length ? `
    <table class="list sortable" id="meeting-items-table">
      <thead><tr>
        <th data-key="student">Student</th><th data-key="student_number">Nr.</th>
        <th data-key="reason">Reden</th><th data-key="tekorten">Tekorten</th>
        <th data-key="present">Aanwezigheid</th><th data-key="absent_allowed">Geoorl. afw.</th>
        <th data-key="absent_unallowed">Ongeoorl. afw.</th><th data-key="sbu">SBU</th>
        <th data-key="conclusion">Conclusie</th><th data-key="followup">Vervolgactie</th><th></th>
      </tr></thead>
      <tbody>${d.items.map((i) => meetingItemRow(i, mayManage)).join("")}</tbody>
    </table>` : `<p class="hint">Geen studenten op de bespreeklijst (niemand voldoet aan de signaleringsregels). Voeg hierboven eventueel handmatig studenten toe.</p>`}
  </div>`;
  $("#meeting-detail").innerHTML = html;
  const back = $("#btn-meeting-back");
  if (back) back.addEventListener("click", () => {
    meetingDetail = null;
    $("#meeting-detail").innerHTML = "";
  });
  const beam = $("#btn-beamer");
  if (beam) beam.addEventListener("click", () => { beamerIndex = 0; renderBeamer(); });
  const printBtn = $("#btn-meeting-print");
  if (printBtn) printBtn.addEventListener("click", printMeetingReport);
  const closeBtn = $("#btn-meeting-close");
  if (closeBtn) closeBtn.addEventListener("click", () => setMeetingStatus("afgerond"));
  const reopenBtn = $("#btn-meeting-reopen");
  if (reopenBtn) reopenBtn.addEventListener("click", () => setMeetingStatus("open"));
  const addBtn = $("#btn-meeting-add");
  if (addBtn) addBtn.addEventListener("click", addMeetingStudent);
  if (d.items.length) {
    bindMeetingItemEvents();
    updateSortArrows("#meeting-items-table", { key: null, dir: 1 });
  }
}

function meetingItemRow(i, mayManage) {
  const dis = mayManage ? "" : " disabled";
  const th = (meetingDetail && meetingDetail.thresholds) || { tekortendrempel: 3, aanwezigheidsgrens: 85 };
  return `<tr data-sid="${i.student_id}">
    <td>${esc(i.student)}</td><td>${esc(i.student_number || "")}</td>
    <td><input data-field="reason" value="${esc(i.reason)}" style="width:180px"${dis}></td>
    <td class="${i.tekorten >= th.tekortendrempel ? "val-onv" : ""}">${i.tekorten}</td>
    <td class="${i.present !== null && i.present < th.aanwezigheidsgrens ? "val-onv" : ""}">${i.present !== null ? i.present + "%" : ""}</td>
    <td class="${i.absent_allowed !== null && i.absent_allowed > 0 ? "val-geel" : ""}">${i.absent_allowed !== null ? i.absent_allowed + "%" : ""}</td>
    <td class="${i.absent_unallowed !== null && i.absent_unallowed > 0 ? "val-onv" : ""}">${i.absent_unallowed !== null ? i.absent_unallowed + "%" : ""}</td>
    <td class="${i.sbu < i.sbu_doel ? "val-onv" : "val-vol"}">${i.sbu} / ${i.sbu_doel}</td>
    <td><textarea data-field="conclusion" rows="2" style="width:220px"${dis}>${esc(i.conclusion)}</textarea></td>
    <td><textarea data-field="followup" rows="2" style="width:220px"${dis}>${esc(i.followup)}</textarea></td>
    <td>${mayManage ? `<button class="danger meeting-item-del" title="Van lijst verwijderen">&times;</button>` : ""}</td>
  </tr>`;
}

function bindMeetingItemEvents() {
  $("#meeting-items-table tbody").addEventListener("change", async (e) => {
    const tr = e.target.closest("tr[data-sid]");
    if (!tr || e.target.dataset.field === undefined) return;
    const sid = +tr.dataset.sid;
    const field = e.target.dataset.field;
    const value = e.target.value.trim();
    try {
      await api(`/api/meetings/${meetingDetail.meeting.id}/items/${sid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const item = meetingDetail.items.find((x) => x.student_id === sid);
      if (item) item[field] = value;
    } catch (err) {
      alert("Opslaan mislukt: " + err.message);
    }
  });
  $("#meeting-items-table tbody").addEventListener("click", async (e) => {
    const btn = e.target.closest(".meeting-item-del");
    if (!btn) return;
    const tr = btn.closest("tr[data-sid]");
    if (!confirm("Deze student van de bespreeklijst verwijderen?")) return;
    try {
      await api(`/api/meetings/${meetingDetail.meeting.id}/items/${tr.dataset.sid}`, { method: "DELETE" });
      await openMeeting(meetingDetail.meeting.id);
      await loadMeetings();
    } catch (err) {
      alert("Verwijderen mislukt: " + err.message);
    }
  });
}

async function addMeetingStudent() {
  const sid = $("#meeting-add-student").value;
  if (!sid) return;
  try {
    await api(`/api/meetings/${meetingDetail.meeting.id}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student_id: +sid, reason: $("#meeting-add-reason").value }),
    });
    await openMeeting(meetingDetail.meeting.id);
    await loadMeetings();
  } catch (err) {
    alert("Toevoegen mislukt: " + err.message);
  }
}

async function setMeetingStatus(status) {
  try {
    await api(`/api/meetings/${meetingDetail.meeting.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadMeetings();
    await openMeeting(meetingDetail.meeting.id);
  } catch (err) {
    alert("Status wijzigen mislukt: " + err.message);
  }
}

// ---------- Beamermodus ----------
function beamerItem() {
  return meetingDetail.items[beamerIndex];
}

function renderBeamer() {
  const d = meetingDetail;
  if (!d || !d.items.length) return alert("Er staan geen studenten op de bespreeklijst.");
  if (beamerIndex >= d.items.length) beamerIndex = 0;
  if (beamerIndex < 0) beamerIndex = d.items.length - 1;
  const i = beamerItem();
  const m = d.meeting;
  const prev = i.previous;
  const th = d.thresholds || { tekortendrempel: 3, aanwezigheidsgrens: 85 };
  $("#beamer-overlay").innerHTML = `
    <div class="beamer-box">
      <div class="beamer-head">
        <div>
          <div class="beamer-title">${esc(m.class_name)} — ${esc(m.period_name)}${m.period_year ? ` (${esc(m.period_year)})` : ""}</div>
          <div class="beamer-subtitle">Rapportvergadering ${esc(m.meeting_date)}</div>
        </div>
        <button id="beamer-exit" class="secondary">Sluiten (Esc)</button>
      </div>
      <div class="beamer-student-head">
        <span class="beamer-name">${esc(i.student)}</span>
        <span class="beamer-number">${esc(i.student_number || "")}</span>
        <span class="beamer-reasons">${i.signals.map((r) => esc(r)).join(" &middot; ") || esc(i.reason) || "&mdash;"}</span>
      </div>
      <div class="beamer-body">
        <div class="beamer-left">
          <table class="beamer-grades">
            <thead><tr><th>Vak</th><th>Beoordeling</th><th>Tek.</th></tr></thead>
            <tbody>${i.grades.map((g) => `
              <tr>
                <td>${esc(g.subject)}</td>
                <td class="${g.tekorten > 0 ? "val-onv" : (g.value === "VS" ? "val-vs" : "val-vol")}">${esc(g.value)}</td>
                <td class="${g.tekorten > 0 ? "val-onv" : ""}">${g.tekorten}</td>
              </tr>`).join("")}</tbody>
          </table>
          <div class="beamer-stats">
            <div class="${i.tekorten >= th.tekortendrempel ? "beamer-stat val-onv" : "beamer-stat"}"><small>Tekorten</small><strong>${i.tekorten}</strong></div>
            <div class="${i.present !== null && i.present < th.aanwezigheidsgrens ? "beamer-stat val-onv" : "beamer-stat"}"><small>Aanwezigheid</small><strong>${i.present !== null ? i.present + "%" : "&mdash;"}</strong></div>
            <div class="${i.absent_allowed !== null && i.absent_allowed > 0 ? "beamer-stat val-geel" : "beamer-stat"}"><small>Geoorloofd afwezig</small><strong>${i.absent_allowed !== null ? i.absent_allowed + "%" : "&mdash;"}</strong></div>
            <div class="${i.absent_unallowed !== null && i.absent_unallowed > 0 ? "beamer-stat val-onv" : "beamer-stat"}"><small>Ongeoorloofd afwezig</small><strong>${i.absent_unallowed !== null ? i.absent_unallowed + "%" : "&mdash;"}</strong></div>
            <div class="${i.sbu < i.sbu_doel ? "beamer-stat val-onv" : "beamer-stat val-vol"}"><small>SBU keuzedelen</small><strong>${i.sbu} / ${i.sbu_doel}</strong></div>
          </div>
        </div>
        <div class="beamer-right">
          ${i.keuzedelen.length ? `<div class="beamer-block"><h3>Keuzedelen</h3>
            <ul class="beamer-kd">${i.keuzedelen.map((k) =>
              `<li>${esc(k.name)} <span class="beamer-kd-sbu">${k.sbu} SBU</span>${k.value ? ` <span class="${k.value === "VS" ? "val-vs" : "val-vol"}">${esc(k.value)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
          ${i.note ? `<div class="beamer-block"><h3>Opmerking (rapport)</h3><p>${esc(i.note)}</p></div>` : ""}
          ${i.teacher_note ? `<div class="beamer-block"><h3>Opmerking docenten</h3><p>${esc(i.teacher_note)}</p></div>` : ""}
          ${prev ? `<div class="beamer-block beamer-prev"><h3>Vorige vergadering (${esc(prev.meeting_date)})</h3>
            ${prev.conclusion ? `<p><strong>Conclusie:</strong> ${esc(prev.conclusion)}</p>` : ""}
            ${prev.followup ? `<p><strong>Vervolgactie:</strong> ${esc(prev.followup)}</p>` : ""}</div>` : ""}
        </div>
      </div>
      <div class="beamer-notes">
        <label>Conclusie:
          <textarea id="beamer-conclusion" rows="2">${esc(i.conclusion)}</textarea>
        </label>
        <label>Vervolgactie:
          <textarea id="beamer-followup" rows="2">${esc(i.followup)}</textarea>
        </label>
        <button id="beamer-save" class="primary">Opslaan</button>
      </div>
      <div class="beamer-nav">
        <button id="beamer-prev" class="secondary"${beamerIndex === 0 ? " disabled" : ""}>&#9664; Vorige</button>
        <span class="beamer-count">${beamerIndex + 1} / ${d.items.length}</span>
        <button id="beamer-next" class="secondary"${beamerIndex === d.items.length - 1 ? " disabled" : ""}>Volgende &#9654;</button>
      </div>
    </div>`;
  const overlay = $("#beamer-overlay");
  overlay.classList.remove("hidden");
  $("#beamer-exit").addEventListener("click", closeBeamer);
  $("#beamer-prev").addEventListener("click", () => { beamerIndex--; renderBeamer(); });
  $("#beamer-next").addEventListener("click", () => { beamerIndex++; renderBeamer(); });
  $("#beamer-save").addEventListener("click", saveBeamerItem);
}

async function saveBeamerItem(advance) {
  const i = beamerItem();
  if (!i) return;
  try {
    const body = {
      conclusion: $("#beamer-conclusion").value,
      followup: $("#beamer-followup").value,
    };
    await api(`/api/meetings/${meetingDetail.meeting.id}/items/${i.student_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    i.conclusion = body.conclusion;
    i.followup = body.followup;
    if (advance !== false) {
      if (beamerIndex < meetingDetail.items.length - 1) {
        beamerIndex++;
        renderBeamer();
      } else {
        closeBeamer();
      }
    }
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
  }
}

function closeBeamer() {
  $("#beamer-overlay").classList.add("hidden");
  $("#beamer-overlay").innerHTML = "";
  if (meetingDetail) renderMeetingDetail();
  loadMeetings();
}

document.addEventListener("keydown", (e) => {
  if ($("#beamer-overlay").classList.contains("hidden")) return;
  if (e.key === "Escape") { closeBeamer(); }
  else if (e.key === "ArrowRight") { if (!e.target.matches("textarea, input")) { e.preventDefault(); beamerIndex++; renderBeamer(); } }
  else if (e.key === "ArrowLeft") { if (!e.target.matches("textarea, input")) { e.preventDefault(); beamerIndex--; renderBeamer(); } }
  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveBeamerItem(); }
});

// ---------- Verslag (print) ----------
function printMeetingReport() {
  const d = meetingDetail;
  if (!d) return;
  const m = d.meeting;
  $("#meeting-print").innerHTML = `
    <div class="report-head">
      <h2>Verslag rapportvergadering</h2>
      <p>${esc(m.class_name)} &mdash; ${esc(periodLabel({ name: m.period_name, year: m.period_year }))} &mdash; ${esc(m.meeting_date)} (${m.status})</p>
    </div>
    ${d.items.length ? d.items.map((i) => `
      <div class="report-card">
        <div class="report-module-header"><strong>${esc(i.student)}</strong>${i.student_number ? ` (nr. ${esc(i.student_number)})` : ""}
          ${i.signals.length ? ` &mdash; ${i.signals.map((s) => esc(s)).join(", ")}` : (i.reason ? ` &mdash; ${esc(i.reason)}` : "")}</div>
        <div class="report-section">
          <table class="list">
            <thead><tr><th>Vak</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
            <tbody>${i.grades.map((g) => `
              <tr><td>${esc(g.subject)}</td>
                <td class="${g.tekorten > 0 ? "val-onv" : ""}">${esc(g.value)}</td>
                <td class="${g.tekorten > 0 ? "val-onv" : ""}">${g.tekorten}</td></tr>`).join("")}</tbody>
          </table>
        </div>
        <div class="report-section"><p><strong>Aanwezigheid:</strong> ${i.present !== null ? i.present + "%" : "&mdash;"} &nbsp; <strong>Geoorloofd afwezig:</strong> ${i.absent_allowed !== null ? i.absent_allowed + "%" : "&mdash;"} &nbsp; <strong>Ongeoorloofd afwezig:</strong> ${i.absent_unallowed !== null ? i.absent_unallowed + "%" : "&mdash;"} &nbsp; <strong>SBU keuzedelen:</strong> ${i.sbu} / ${i.sbu_doel}</p></div>
        ${i.conclusion ? `<div class="report-section"><p><strong>Conclusie:</strong> ${esc(i.conclusion)}</p></div>` : ""}
        ${i.followup ? `<div class="report-section"><p><strong>Vervolgactie:</strong> ${esc(i.followup)}</p></div>` : ""}
      </div>`).join("") : `<p>Geen studenten besproken.</p>`}
  `;
  window.print();
}

// ---------- Archief ----------
let archiveData = {};   // tabel-id -> rijen
let archiveState = {};  // tabel-id -> {q, sortKey, sortDir}

const ARCH_TABLES = {
  "arch-students-table": { search: "arch-students-search", cols: ["name", "student_number"], empty: 3 },
  "arch-classes-table": { search: "arch-classes-search", cols: ["name", "crebo", "cohort"], empty: 4 },
  "arch-subjects-table": { search: "arch-subjects-search", cols: ["name"], empty: 2 },
  "arch-cohorts-table": { search: "arch-cohorts-search", cols: ["name"], empty: 2 },
  "arch-leertrajecten-table": { search: "arch-leertrajecten-search", cols: ["name", "crebo"], empty: 3 },
};

async function renderArchive() {
  const [archStudents, archClasses, archSubjects, archCohorts, archLeertrajecten] = await Promise.all([
    api("/api/students?archived=1"), api("/api/classes?archived=1"),
    api("/api/subjects?archived=1"), api("/api/cohorts?archived=1"),
    api("/api/leertrajecten?archived=1"),
  ]);
  archiveData = {
    "arch-students-table": archStudents,
    "arch-classes-table": archClasses,
    "arch-subjects-table": archSubjects,
    "arch-cohorts-table": archCohorts,
    "arch-leertrajecten-table": archLeertrajecten,
  };
  for (const tableId of Object.keys(ARCH_TABLES)) renderArchTable(tableId);
}

function renderArchTable(tableId) {
  const cfg = ARCH_TABLES[tableId];
  const table = $("#" + tableId);
  const state = archiveState[tableId] || (archiveState[tableId] = { q: "", sortKey: null, sortDir: 1 });
  let rows = archiveData[tableId] || [];
  const q = state.q.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => cfg.cols.some(
      (c) => (r[c] || "").toString().toLowerCase().includes(q)));
  }
  if (state.sortKey) {
    const key = state.sortKey;
    rows = [...rows].sort((a, b) => {
      const av = (a[key] || "").toString().toLowerCase();
      const bv = (b[key] || "").toString().toLowerCase();
      return av < bv ? -state.sortDir : av > bv ? state.sortDir : 0;
    });
  }
  // sorteer-indicator in de kop
  table.querySelectorAll("thead th[data-key]").forEach((th) => {
    const key = "#" + table.id + "|" + th.dataset.key;
    if (!(key in SORT_LABELS)) SORT_LABELS[key] = th.textContent.trim();
    const label = SORT_LABELS[key];
    const mark = th.dataset.key === state.sortKey
      ? (state.sortDir === 1 ? "\u25BE" : "\u25B4")
      : "\u21C5";
    const cls = key === state.sortKey ? "sort-indicator active" : "sort-indicator";
    th.innerHTML = esc(label) + ` <span class="${cls}">${mark}</span>`;
  });
  const kind = table.dataset.kind;
  const mayUnarchive = kind === "students" ? isRole("beheerder", "mentor") : isAdmin();
  const unarchiveBtn = mayUnarchive ? `<button class="secondary" data-unarchive>Terugzetten</button>` : "";
  const cells = (r) => cfg.cols.map((c) => `<td>${esc(r[c] || "")}</td>`).join("");
  const pageRows = pageSlice("#" + table.id, rows);
  table.querySelector("tbody").innerHTML = rows.length
    ? pageRows.map((r) => `<tr data-id="${r.id}" data-kind="${kind}">${cells(r)}<td>${unarchiveBtn}</td></tr>`).join("")
    : `<tr><td colspan="${cfg.empty}" class="hint">${q ? "Niets gevonden voor deze zoekopdracht." : "Niets gearchiveerd."}</td></tr>`;
}

async function setArchived(kind, id, archived) {
  await api(`/api/${kind}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  await loadAll();
  await renderArchive();
}

$$("nav [data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "archief") renderArchive();
    if (btn.dataset.tab === "logboek") renderAuditLog();
    if (btn.dataset.tab === "keuzedelen") { renderKeuzedelenTab(); loadKdMatrix(); loadKdBulk(); }
    if (btn.dataset.tab === "statistieken") fillStatFilters();
    if (btn.dataset.tab === "vergadering") renderMeetingsTab();
    if (btn.dataset.tab === "instellingen") renderMailOutbox().catch(() => {});
  });
});

// ---------- Logboek ----------
let auditEntries = [];
let auditSort = { key: null, dir: 1 };

async function renderAuditLog() {
  try {
    auditEntries = await api("/api/auditlog");
  } catch (err) {
    auditEntries = [];
  }
  fillLogFilterOptions();
  renderAuditTable();
}

function fillLogFilterOptions() {
  const entitySel = $("#log-entity-filter");
  const userSel = $("#log-user-filter");
  const entities = [...new Set(auditEntries.map((r) => r.entity).filter(Boolean))].sort();
  const usernames = [...new Set(auditEntries.map((r) => r.username).filter(Boolean))].sort();
  const prevEntity = entitySel.value;
  const prevUser = userSel.value;
  entitySel.innerHTML = `<option value="">Alle soorten</option>` +
    entities.map((e) => `<option value="${esc(e)}"${e === prevEntity ? " selected" : ""}>${esc(e)}</option>`).join("");
  userSel.innerHTML = `<option value="">Alle gebruikers</option>` +
    usernames.map((u) => `<option value="${esc(u)}"${u === prevUser ? " selected" : ""}>${esc(u)}</option>`).join("");
}

function auditFilteredRows() {
  const q = ($("#log-search").value || "").trim().toLowerCase();
  const entity = $("#log-entity-filter").value;
  const username = $("#log-user-filter").value;
  let rows = auditEntries;
  if (entity) rows = rows.filter((r) => r.entity === entity);
  if (username) rows = rows.filter((r) => r.username === username);
  if (q) {
    rows = rows.filter((r) =>
      (r.username || "").toLowerCase().includes(q) ||
      (r.action || "").toLowerCase().includes(q) ||
      (r.entity || "").toLowerCase().includes(q) ||
      (r.detail || "").toLowerCase().includes(q));
  }
  return sortRows(rows, auditSort, (r, key) => key === "ts" ? r[key] : (r[key] || ""));
}

function renderAuditTable() {
  const rows = auditFilteredRows();
  updateSortArrows("#audit-table", auditSort);
  $("#audit-table tbody").innerHTML = pageSlice("#audit-table", rows).map((r) => `
    <tr>
      <td>${esc(r.ts || "")}</td>
      <td>${esc(r.username || "")}</td>
      <td>${esc(r.action || "")}</td>
      <td>${esc(r.entity || "")}</td>
      <td>${esc(r.detail || "")}</td>
    </tr>`).join("");
}

$("#log-search").addEventListener("input", () => { resetPage("#audit-table"); renderAuditTable(); });
$("#log-entity-filter").addEventListener("change", () => { resetPage("#audit-table"); renderAuditTable(); });
$("#log-user-filter").addEventListener("change", () => { resetPage("#audit-table"); renderAuditTable(); });

$("#btn-log-export").addEventListener("click", () => {
  const rows = auditFilteredRows();
  if (!rows.length) return alert("Er zijn geen logregels om te exporteren.");
  const escCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Tijd", "Gebruiker", "Actie", "Soort", "Details"].map(escCsv).join(";"),
    ...rows.map((r) => [r.ts, r.username, r.action, r.entity, r.detail].map(escCsv).join(";")),
  ];
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.download = `logboek-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});
$("#audit-table thead").addEventListener("click", (e) => {
  const key = e.target.dataset.key;
  if (key === undefined) return;
  if (auditSort.key === key) auditSort.dir = auditSort.dir === 1 ? -1 : 1;
  else { auditSort.key = key; auditSort.dir = 1; }
  renderAuditTable();
});

for (const tableId of Object.keys(ARCH_TABLES)) {
  $("#" + ARCH_TABLES[tableId].search).addEventListener("input", (e) => {
    archiveState[tableId].q = e.target.value;
    resetPage("#" + tableId);
    renderArchTable(tableId);
  });
  $("#" + tableId).querySelector("thead").addEventListener("click", (e) => {
    const key = e.target.dataset.key;
    if (key === undefined) return;
    const state = archiveState[tableId];
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 1 ? -1 : 1;
    } else {
      state.sortKey = key;
      state.sortDir = 1;
    }
    renderArchTable(tableId);
  });
}

for (const sel of ["#students-table tbody", "#classes-table tbody", "#subjects-table tbody"]) {
  $(sel).addEventListener("click", async (e) => {
    if (e.target.dataset.archive === undefined) return;
    const tr = e.target.closest("tr");
    const kind = sel.includes("students") ? "students"
      : sel.includes("classes") ? "classes" : "subjects";
    if (!confirm("Archiveren? De gegevens blijven bewaard maar verdwijnen uit de actieve overzichten.")) return;
    await setArchived(kind, tr.dataset.id, true);
  });
}

for (const tableId of Object.keys(ARCH_TABLES)) {
  $("#" + tableId).querySelector("tbody").addEventListener("click", async (e) => {
    if (e.target.dataset.unarchive === undefined) return;
    const tr = e.target.closest("tr");
    await setArchived(tr.dataset.kind, tr.dataset.id, false);
  });
}

// ---------- Gebruikers ----------
function renderUsers() {
  if (!$("#users-table")) return;
  const q = ($("#users-search") ? $("#users-search").value : "").trim().toLowerCase();
  const roleFilter = $("#users-role-filter") ? $("#users-role-filter").value : "";
  const activeFilter = $("#users-active-filter") ? $("#users-active-filter").value : "";
  let visible = users;
  if (q) {
    visible = visible.filter((u) =>
      (u.username || "").toLowerCase().includes(q) ||
      (u.first_name || "").toLowerCase().includes(q) ||
      (u.last_name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.student_name || "").toLowerCase().includes(q));
  }
  if (roleFilter) visible = visible.filter((u) => u.role === roleFilter);
  if (activeFilter !== "") visible = visible.filter((u) => String(u.active ? 1 : 0) === activeFilter);
  const rows = sortRows(visible, listSort.users, (u, key) =>
    key === "role" ? (ROLE_LABELS[u.role] || u.role)
    : key === "active" ? (u.active ? "1" : "0")
    : (u[key] || ""));
  updateSortArrows("#users-table", listSort.users);
  $("#users-table tbody").innerHTML = pageSlice("#users-table", rows).map((u) => `
    <tr data-id="${u.id}">
      <td><input type="checkbox" class="row-select" data-id="${u.id}"></td>
      <td>${esc(u.username)}</td>
      <td><input data-field="first_name" value="${esc(u.first_name || "")}" style="width:110px"></td>
      <td><input data-field="last_name" value="${esc(u.last_name || "")}" style="width:110px"></td>
      <td><input type="email" data-field="email" value="${esc(u.email || "")}" style="width:170px"></td>
      <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
      <td>${esc(u.student_name || "")}</td>
      <td><input type="checkbox" data-field="active"${u.active ? " checked" : ""}></td>
      <td><input type="password" placeholder="Nieuw wachtwoord" data-field="password" style="width:140px"></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
  fillUserStudentOptions();
  updateUsersBulkBar();
}

function studentsWithoutAccount() {
  const taken = new Set(users.filter((u) => u.student_id).map((u) => u.student_id));
  return students.filter((s) => !s.archived && !taken.has(s.id));
}

function fillUserStudentOptions() {
  const sel = $("#user-student");
  if (!sel) return;
  const prev = sel.value;
  const opts = studentsWithoutAccount();
  sel.innerHTML = `<option value="">Kies student...</option>` +
    opts.map((s) => `<option value="${s.id}">${esc(studentName(s))}${s.student_number ? " (" + esc(s.student_number) + ")" : ""}</option>`).join("");
  sel.value = opts.some((s) => String(s.id) === prev) ? prev : "";
}

function selectedUserIds() {
  return [...$$("#users-table tbody input.row-select:checked")].map((cb) => +cb.dataset.id);
}

function updateUsersBulkBar() {
  const bar = $("#users-bulk-bar");
  if (!bar) return;
  const n = selectedUserIds().length;
  bar.classList.toggle("hidden", n === 0);
  $("#users-bulk-count").textContent = n + " geselecteerd";
}

async function usersBulkAction(action, confirmMsg) {
  const ids = selectedUserIds();
  if (!ids.length) return;
  if (confirmMsg && !confirm(confirmMsg.replace("{n}", ids.length))) return;
  try {
    const res = await api("/api/users/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    if (res.errors && res.errors.length) {
      alert("Deels mislukt:\n" + res.errors.join("\n"));
    } else if (action === "reset_password") {
      alert("Wachtwoorden gereset naar het standaardwachtwoord (welkom, beheerders: rapportapp). Bij de volgende login moet een nieuw wachtwoord gekozen worden.");
    }
    await loadAll();
  } catch (err) {
    alert("Bulkactie mislukt: " + err.message);
  }
}

$("#users-bulk-active-on").addEventListener("click", () =>
  usersBulkAction("active_on"));
$("#users-bulk-active-off").addEventListener("click", () =>
  usersBulkAction("active_off"));
$("#users-bulk-reset").addEventListener("click", () =>
  usersBulkAction("reset_password",
    "Wachtwoord van {n} account(s) resetten naar het standaardwachtwoord?"));

$("#users-select-all").addEventListener("change", (e) => {
  $$("#users-table tbody input.row-select").forEach((cb) => {
    cb.checked = e.target.checked;
  });
  updateUsersBulkBar();
});

$("#users-table tbody").addEventListener("change", (e) => {
  if (e.target.classList.contains("row-select")) updateUsersBulkBar();
});

$("#user-role").addEventListener("change", (e) => {
  const isStudent = e.target.value === "student";
  $("#user-student").classList.toggle("hidden", !isStudent);
  if (isStudent && !$("#user-password").value) $("#user-password").value = "welkom";
});

$("#import-users-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setImportBusy("#users-import-result", file.name);
  try {
    const res = await api("/api/users/import", {
      method: "POST",
      body: (() => { const fd = new FormData(); fd.append("file", file); return fd; })(),
    });
    const el = $("#users-import-result");
    el.classList.remove("hidden");
    setResultKind(el, res.errors && res.errors.length);
    let msg = `Toegevoegd: ${res.imported}`;
    if (res.skipped) msg += `, overgeslagen (bestaat al): ${res.skipped}`;
    if (res.errors && res.errors.length) msg += "\nFouten:\n" + res.errors.join("\n");
    el.textContent = msg;
    await loadAll();
  } catch (err) {
    const el = $("#users-import-result");
    el.classList.remove("hidden");
    setResultKind(el, true);
    el.textContent = "Import mislukt: " + err.message;
  }
  e.target.value = "";
});

$("#btn-add-user").addEventListener("click", async () => {
  const username = $("#user-username").value.trim();
  const password = $("#user-password").value;
  const role = $("#user-role").value;
  const studentId = role === "student" ? ($("#user-student").value || null) : null;
  if (!username || !password) return alert("Vul gebruikersnaam en wachtwoord in.");
  if (role === "student" && !studentId) return alert("Kies de student voor dit account (alleen studenten zonder account staan in de lijst).");
  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username, password, role, student_id: studentId,
        first_name: $("#user-firstname").value.trim(),
        last_name: $("#user-lastname").value.trim(),
        email: $("#user-email").value.trim(),
      }),
    });
    $("#user-username").value = "";
    $("#user-password").value = "";
    $("#user-firstname").value = "";
    $("#user-lastname").value = "";
    $("#user-email").value = "";
    await loadAll();
  } catch (err) {
    alert("Account aanmaken mislukt: " + err.message);
  }
});

$("#users-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const id = tr.dataset.id;
  const field = e.target.dataset.field;
  const body = {};
  if (field === "active") body.active = e.target.checked;
  if (field === "password" && e.target.value) body.password = e.target.value;
  if (["first_name", "last_name", "email"].includes(field)) body[field] = e.target.value;
  if (!Object.keys(body).length) return;
  try {
    await api(`/api/users/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (e.target.dataset.field === "password") e.target.value = "";
    users = await api("/api/users");
    renderUsers();
  } catch (err) {
    alert(err.message);
  }
});

$("#users-table tbody").addEventListener("click", async (e) => {
  if (e.target.dataset.del === undefined) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Dit account verwijderen?")) return;
  try {
    await api(`/api/users/${id}`, { method: "DELETE" });
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Darkmode ----------
const themeBtn = $("#btn-theme");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("rapportapp-theme", theme);
}
applyTheme(localStorage.getItem("rapportapp-theme") ||
  (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

function fmtPct(v) {
  if (v === null || v === undefined || v === "") return "";
  return String(v).replace(".", ",") + "%";
}

// ---------- Instellingen ----------
function renderSettingsUi() {
  const nameInput = $("#settings-school-name");
  if (nameInput) nameInput.value = settings.school_name || "";
  const tInput = $("#settings-tekortendrempel");
  if (tInput) tInput.value = settings.signal_tekortendrempel ?? 3;
  const aInput = $("#settings-aanwezigheidsgrens");
  if (aInput) aInput.value = settings.signal_aanwezigheidsgrens ?? 85;
  const preview = $("#settings-logo-preview");
  if (preview) {
    preview.src = settings.logo || "";
    preview.classList.toggle("hidden", !settings.logo);
  }
  const removeBtn = $("#btn-remove-logo");
  if (removeBtn) removeBtn.classList.toggle("hidden", !settings.logo);
  const smtpHost = $("#settings-smtp-host");
  if (smtpHost) {
    smtpHost.value = settings.smtp_host || "";
    $("#settings-smtp-port").value = settings.smtp_port || "";
    $("#settings-smtp-user").value = settings.smtp_user || "";
    $("#settings-smtp-pass").value = "";
    $("#settings-smtp-pass").placeholder = settings.smtp_pass_set ? "(ongewijzigd)" : "";
    $("#settings-smtp-from").value = settings.smtp_from || "";
    $("#settings-smtp-starttls").checked = settings.smtp_starttls !== false;
    $("#settings-mail-vergadering").value = (settings.mail_recipients && settings.mail_recipients.vergadering) || "";
    $("#settings-mail-rapport").value = (settings.mail_recipients && settings.mail_recipients.rapport) || "";
    $("#settings-mailmode-vergadering").value = (settings.mail_modes && settings.mail_modes.vergadering) || "direct";
    $("#settings-mailmode-rapport").value = (settings.mail_modes && settings.mail_modes.rapport) || "direct";
  }
  pendingLogo = null;
}

function markSettingsUnsaved() {
  const result = $("#settings-result");
  result.textContent = "Wijzigingen nog niet opgeslagen \u2014 klik op 'Instellingen opslaan'.";
  result.classList.remove("hidden", "ok", "err");
}

$("#settings-school-name").addEventListener("input", markSettingsUnsaved);
$("#settings-tekortendrempel").addEventListener("input", markSettingsUnsaved);
$("#settings-aanwezigheidsgrens").addEventListener("input", markSettingsUnsaved);
for (const sel of ["#settings-smtp-host", "#settings-smtp-port", "#settings-smtp-user",
                   "#settings-smtp-pass", "#settings-smtp-from", "#settings-mail-vergadering",
                   "#settings-mail-rapport"]) {
  $(sel).addEventListener("input", markSettingsUnsaved);
}
for (const sel of ["#settings-smtp-starttls", "#settings-mailmode-vergadering",
                   "#settings-mailmode-rapport"]) {
  $(sel).addEventListener("change", markSettingsUnsaved);
}

$("#settings-logo-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 700 * 1024) return alert("Logo is te groot (max. 700 kB).");
  pendingLogo = new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result);
      const preview = $("#settings-logo-preview");
      preview.src = reader.result;
      preview.classList.remove("hidden");
      $("#btn-remove-logo").classList.remove("hidden");
      markSettingsUnsaved();
    };
    reader.onerror = () => {
      reject(new Error("Logo kon niet worden ingelezen door de browser."));
      pendingLogo = null;
    };
    reader.readAsDataURL(file);
  });
});

$("#btn-remove-logo").addEventListener("click", () => {
  pendingLogo = "";
  const preview = $("#settings-logo-preview");
  preview.src = "";
  preview.classList.add("hidden");
  $("#btn-remove-logo").classList.add("hidden");
  markSettingsUnsaved();
});

$("#btn-save-settings").addEventListener("click", async () => {
  const body = {
    school_name: $("#settings-school-name").value,
    signal_tekortendrempel: +$("#settings-tekortendrempel").value || 3,
    signal_aanwezigheidsgrens: +$("#settings-aanwezigheidsgrens").value || 85,
  };
  if ($("#settings-smtp-host")) {
    body.smtp_host = $("#settings-smtp-host").value;
    body.smtp_port = $("#settings-smtp-port").value;
    body.smtp_user = $("#settings-smtp-user").value;
    body.smtp_from = $("#settings-smtp-from").value;
    body.smtp_starttls = $("#settings-smtp-starttls").checked;
    body.mail_recipients_vergadering = $("#settings-mail-vergadering").value;
    body.mail_recipients_rapport = $("#settings-mail-rapport").value;
    body.mail_mode_vergadering = $("#settings-mailmode-vergadering").value;
    body.mail_mode_rapport = $("#settings-mailmode-rapport").value;
    const pass = $("#settings-smtp-pass").value;
    if (pass) body.smtp_pass = pass;
  }
  let logoMeegestuurd = false;
  if (pendingLogo !== null) {
    try {
      body.logo = await pendingLogo;
      logoMeegestuurd = true;
    } catch (err) {
      alert(err.message);
      return;
    }
  }
  const result = $("#settings-result");
  try {
    settings = await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    pendingLogo = null;
    applySchoolName();
    renderSettingsUi();
    if (logoMeegestuurd && !settings.logo) {
      alert("Het logo is NIET opgeslagen door de server. " +
            "Controleer of de app op de server is bijgewerkt (git pull + herstart) en probeer het opnieuw.");
    }
    result.textContent = logoMeegestuurd
      ? (settings.logo ? "Instellingen opgeslagen, logo bewaard." : "Instellingen opgeslagen, maar logo ontbreekt op de server!")
      : (settings.logo ? "Instellingen opgeslagen (logo ongewijzigd)." : "Instellingen opgeslagen.");
    result.classList.remove("hidden");
    setResultKind(result, logoMeegestuurd && !settings.logo);
    if ($("#report-output") && $("#report-output").innerHTML.trim()) {
      showReport().catch(() => {});
    }
  } catch (err) {
    alert("Opslaan mislukt: " + err.message);
    result.textContent = err.message;
    result.classList.remove("hidden");
    setResultKind(result, true);
  }
});

// ---------- E-mailmeldingen: overzicht, testmail, samenvatting ----------
let mailEntries = [];
let mailSort = { key: null, dir: 1 };

async function renderMailOutbox() {
  try {
    mailEntries = await api("/api/mail/outbox");
  } catch (err) {
    mailEntries = [];
  }
  const pending = mailEntries.filter((r) => !r.sent_at && !r.error).length;
  const hint = $("#mail-pending-hint");
  if (hint) hint.textContent = pending
    ? `${pending} melding(en) wachten op de dagelijkse samenvatting.`
    : "";
  renderMailTable();
}

function mailStatus(r) {
  if (r.sent_at) return "verzonden";
  return r.error ? "mislukt" : "wachtend";
}

function mailFilteredRows() {
  const q = ($("#mail-search").value || "").trim().toLowerCase();
  const event = $("#mail-event-filter").value;
  const status = $("#mail-status-filter").value;
  let rows = mailEntries;
  if (event) rows = rows.filter((r) => r.event === event);
  if (status) rows = rows.filter((r) => mailStatus(r) === status);
  if (q) {
    rows = rows.filter((r) =>
      (r.subject || "").toLowerCase().includes(q) ||
      (r.recipients || "").toLowerCase().includes(q) ||
      (r.error || "").toLowerCase().includes(q));
  }
  return sortRows(rows, mailSort, (r, key) =>
    key === "status" ? mailStatus(r) : (r[key] || ""));
}

function renderMailTable() {
  const rows = mailFilteredRows();
  updateSortArrows("#mail-table", mailSort);
  $("#mail-table tbody").innerHTML = rows.length
    ? pageSlice("#mail-table", rows).map((r) => `
      <tr>
        <td>${esc(r.created_at || "")}</td>
        <td>${esc(r.event === "vergadering" ? "Vergadering" : "Rapport gereed")}</td>
        <td>${esc(r.subject || "")}</td>
        <td>${esc(r.recipients || "")}</td>
        <td>${esc(mailStatus(r))}${r.sent_at ? " " + esc(r.sent_at) : ""}</td>
        <td>${esc(r.error || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="hint">Geen e-mailmeldingen.</td></tr>`;
}

$("#mail-search").addEventListener("input", () => { resetPage("#mail-table"); renderMailTable(); });
$("#mail-event-filter").addEventListener("change", () => { resetPage("#mail-table"); renderMailTable(); });
$("#mail-status-filter").addEventListener("change", () => { resetPage("#mail-table"); renderMailTable(); });
$("#mail-table thead").addEventListener("click", (e) => {
  const key = e.target.dataset.key;
  if (key === undefined) return;
  if (mailSort.key === key) mailSort.dir = mailSort.dir === 1 ? -1 : 1;
  else { mailSort.key = key; mailSort.dir = 1; }
  renderMailTable();
});

$("#btn-mail-test").addEventListener("click", async () => {
  const btn = $("#btn-mail-test");
  btn.disabled = true;
  try {
    const res = await api("/api/mail/test", { method: "POST" });
    alert("Testmail verstuurd naar: " + res.recipients.join(", "));
  } catch (err) {
    alert("Testmail mislukt: " + err.message);
  } finally {
    btn.disabled = false;
    renderMailOutbox().catch(() => {});
  }
});

$("#btn-mail-digest").addEventListener("click", async () => {
  const btn = $("#btn-mail-digest");
  btn.disabled = true;
  try {
    const res = await api("/api/mail/digest", { method: "POST" });
    alert(`Samenvatting verstuurd (${res.sent} melding(en)).`);
  } catch (err) {
    alert("Samenvatting niet verstuurd: " + err.message);
  } finally {
    btn.disabled = false;
    renderMailOutbox().catch(() => {});
  }
});

// ---------- Wachtwoord wijzigen (verplicht bij standaardwachtwoord) ----------
function showPasswordChangeDialog() {
  ["#pwchange-current", "#pwchange-new", "#pwchange-repeat"].forEach((sel) => { $(sel).value = ""; });
  $("#pwchange-error").classList.add("hidden");
  $("#pwchange-dialog").classList.remove("hidden");
  $("#pwchange-current").focus();
}

$("#pwchange-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#pwchange-error");
  errEl.classList.add("hidden");
  const nieuw = $("#pwchange-new").value;
  if (nieuw !== $("#pwchange-repeat").value) {
    errEl.textContent = "De nieuwe wachtwoorden zijn niet gelijk.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await api("/api/auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_password: $("#pwchange-current").value,
        new_password: nieuw,
      }),
    });
    currentUser.must_change_password = 0;
    $("#pwchange-dialog").classList.add("hidden");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init().catch((e) => alert("Laden mislukt: " + e.message));
