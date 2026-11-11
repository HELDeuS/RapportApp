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

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let currentUser = null;

const listSort = {
  students: { key: "name", dir: 1 },
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
    const av = (fieldOf(a, state.key) || "").toString().toLowerCase();
    const bv = (fieldOf(b, state.key) || "").toString().toLowerCase();
    return av < bv ? -dir : av > bv ? dir : 0;
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
    text: "Naam;Vaknaam 1;Vaknaam 2\nJan Jansen;7,5;VS\nPiet Pietersen;O;5,2\n",
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
  beheerder: ["cijfers", "studenten", "klassen", "vakken", "periodes", "keuzedelen", "statistieken", "rapport", "archief", "gebruikers", "logboek"],
  mentor: ["cijfers", "studenten", "keuzedelen", "statistieken", "rapport", "archief", "logboek"],
  docent: ["cijfers", "keuzedelen", "statistieken", "rapport", "logboek"],
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

function applyRoleUi() {
  const role = currentUser ? currentUser.role : null;
  $$(".tab").forEach((btn) => {
    btn.style.display = role && ROLE_TABS[role].includes(btn.dataset.tab) ? "" : "none";
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
  const kdAddBar = $("#kd-add-bar");
  if (kdAddBar) kdAddBar.style.display = isAdmin() ? "" : "none";
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
  $$(".tab").forEach((b) => b.classList.remove("active"));
  const firstTab = [...$$(".tab")].find((b) => b.style.display !== "none");
  if (firstTab) {
    firstTab.classList.add("active");
    $(`#tab-${firstTab.dataset.tab}`).classList.add("active");
  }
}

async function init() {
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

// ---------- Tabs ----------
$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active", "hidden"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
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
  for (const sel of [$("#student-cohort"), $("#report-cohort"), $("#grade-cohort")]) {
    sel.innerHTML = `<option value="">Alle cohorten</option>` +
      cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  }
  $("#student-class-filter").innerHTML = `<option value="">Alle klassen</option>` +
    ownClassesOnly(classes).map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
}

function renderClassSelects() {
  const cohortFilter = $("#grade-cohort").value;
  const visibleClasses = ownClassesOnly(cohortFilter
    ? classes.filter((c) => String(c.cohort_id) === cohortFilter)
    : classes);
  const grouped = (sel) => {
    const byCohort = {};
    for (const c of visibleClasses) {
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
  gradeSel.innerHTML = grouped(prevGrade);
  const reportSel = $("#report-class");
  const prevReport = reportSel.value;
  reportSel.innerHTML = grouped(prevReport);
  $("#student-class").innerHTML = `<option value="">Geen klas</option>` +
    visibleClasses.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
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
  if (classId) return students.filter((s) => String(s.class_id) === classId);
  const cohortId = $("#grade-cohort").value;
  if (cohortId) return students.filter((s) => {
    const c = classes.find((x) => x.id === s.class_id);
    return c && String(c.cohort_id) === cohortId;
  });
  return students;
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

$("#grade-cohort").addEventListener("change", () => {
  renderClassSelects();
  renderGradeTable();
});

$("#student-search").addEventListener("input", () => { resetPage("#students-table"); renderStudents(); });
$("#student-cohort").addEventListener("change", () => { resetPage("#students-table"); renderStudents(); });
$("#student-class-filter").addEventListener("change", () => { resetPage("#students-table"); renderStudents(); });

bindTableSort("#students-table", "students", renderStudents);
bindTableSort("#classes-table", "classes", renderClasses);
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

function showImportResult(res) {
  const el = $("#import-result");
  el.classList.remove("hidden");
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
    : key === "login_enabled" ? (s.login_enabled ? "1" : "0")
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
      <td title="${s.login_username ? "Gebruikersnaam: " + esc(s.login_username) : "Nog geen account"}"><input type="checkbox" data-field="login_enabled"${s.login_enabled ? " checked" : ""}></td>
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
    const res = await api("/api/students/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    if (action === "login_on" && res.usernames && res.usernames.length) {
      alert("Accounts aangemaakt (" + res.usernames.length + ").\nGebruikersnamen: " + res.usernames.join(", ") + "\nStandaardwachtwoord: welkom");
    }
    await loadAll();
  } catch (err) {
    alert("Bulkactie mislukt: " + err.message);
  }
}

$("#bulk-login-on").addEventListener("click", () => bulkAction("login_on"));
$("#bulk-login-off").addEventListener("click", () => bulkAction("login_off"));
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
  if (e.target.dataset.field === "login_enabled") {
    try {
      const res = await api(`/api/students/${s.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login_enabled: e.target.checked }),
      });
      if (e.target.checked && res.login_username) {
        const msg = "Account aangemaakt voor " + studentName(s) + ".\nGebruikersnaam: " + res.login_username + "\nStandaardwachtwoord: welkom";
        alert(msg);
      }
      await loadAll();
    } catch (err) {
      alert(err.message);
      await loadAll();
    }
    return;
  }
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

function renderClasses() {
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
  refillKeepingValue("#lt-add-crebo", creboOptions(""));
  refillKeepingValue("#lt-add-cohort", optList("", cohorts, "Geen cohort"));
  refillKeepingValue("#lt-crebo", creboOptions(""));
  refillKeepingValue("#lt-cohort", optList("", cohorts, "Geen cohort"));
  refillKeepingValue("#lt-manage", leertrajecten.length
    ? leertrajecten.map((t) => `<option value="${t.id}">${esc(ltLabel(t))}</option>`).join("")
    : `<option value="">(geen leertrajecten)</option>`);
  const selLt = leertrajecten.find((t) => String(t.id) === $("#lt-manage").value);
  $("#lt-crebo").value = selLt && selLt.crebo_id ? selLt.crebo_id : "";
  $("#lt-cohort").value = selLt && selLt.cohort_id ? selLt.cohort_id : "";
  refillKeepingValue("#crebo-manage", crebos.length
    ? crebos.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("")
    : `<option value="">(geen crebos)</option>`);
  refillKeepingValue("#cohort-manage", cohorts.length
    ? cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")
    : `<option value="">(geen cohorten)</option>`);
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

$("#btn-archive-cohort").addEventListener("click", async () => {
  const id = $("#cohort-manage").value;
  if (!id) return;
  if (!confirm("Cohort archiveren? Het verdwijnt uit de actieve overzichten; klassen en studenten blijven bewaard.")) return;
  await api(`/api/cohorts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  await loadAll();
});

$("#btn-del-cohort").addEventListener("click", async () => {
  const id = $("#cohort-manage").value;
  if (!id) return;
  if (!confirm("Cohort verwijderen? Klassen met dit cohort verliezen hun cohort.")) return;
  await api(`/api/cohorts/${id}`, { method: "DELETE" });
  await loadAll();
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

$("#lt-manage").addEventListener("change", () => {
  const lt = leertrajecten.find((t) => String(t.id) === $("#lt-manage").value);
  $("#lt-crebo").value = lt && lt.crebo_id ? lt.crebo_id : "";
  $("#lt-cohort").value = lt && lt.cohort_id ? lt.cohort_id : "";
});

$("#lt-crebo").addEventListener("change", async () => {
  const id = $("#lt-manage").value;
  if (!id) return;
  try {
    await api(`/api/leertrajecten/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crebo_id: $("#lt-crebo").value || null }),
    });
    await loadAll();
  } catch (err) {
    alert("Crebo opslaan mislukt: " + err.message);
  }
});

$("#lt-cohort").addEventListener("change", async () => {
  const id = $("#lt-manage").value;
  if (!id) return;
  try {
    await api(`/api/leertrajecten/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cohort_id: $("#lt-cohort").value || null }),
    });
    await loadAll();
  } catch (err) {
    alert("Startcohort opslaan mislukt: " + err.message);
  }
});

$("#btn-add-lt").addEventListener("click", async () => {
  const name = $("#lt-name").value.trim();
  if (!name) return alert("Vul eerst een naam in (bijv. ICT 2-jarig).");
  try {
    const res = await api("/api/leertrajecten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, crebo_id: $("#lt-add-crebo").value || null,
                             cohort_id: $("#lt-add-cohort").value || null }),
    });
    $("#lt-name").value = "";
    $("#lt-add-crebo").value = "";
    $("#lt-add-cohort").value = "";
    await loadAll();
    if (res && res.id) {
      const manage = $("#lt-manage");
      if ([...manage.options].some((o) => o.value === String(res.id))) manage.value = String(res.id);
      manage.dispatchEvent(new Event("change"));
    }
  } catch (err) {
    alert("Leertraject toevoegen mislukt: " + err.message);
  }
});

$("#btn-archive-lt").addEventListener("click", async () => {
  const id = $("#lt-manage").value;
  if (!id) return;
  if (!confirm("Leertraject archiveren? Het verdwijnt uit de actieve overzichten; gegevens blijven bewaard.")) return;
  await api(`/api/leertrajecten/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  await loadAll();
});

$("#btn-del-lt").addEventListener("click", async () => {
  const id = $("#lt-manage").value;
  if (!id) return;
  if (!confirm("Leertraject verwijderen? Klassen met dit leertraject verliezen hun leertraject.")) return;
  await api(`/api/leertrajecten/${id}`, { method: "DELETE" });
  await loadAll();
});

$("#report-class").addEventListener("change", () => renderPeriodSelects());

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

$("#btn-del-crebo").addEventListener("click", async () => {
  const id = $("#crebo-manage").value;
  if (!id) return;
  if (!confirm("Crebo verwijderen? Leertrajecten met dit crebo verliezen hun crebo.")) return;
  await api(`/api/crebos/${id}`, { method: "DELETE" });
  await loadAll();
});

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
  let msg = `Toegevoegd: ${res.imported}`;
  if (res.skipped) msg += `, overgeslagen (bestaat al): ${res.skipped}`;
  if (res.errors && res.errors.length) msg += `\nFouten:\n` + res.errors.join("\n");
  el.textContent = msg;
}

// Import studenten via CSV/Excel
$("#import-students-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
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
  out.innerHTML += (periodOverride ? `<h2 class="report-module-header">Module: ${esc(periodLabel(periodOverride))}</h2>` : "") +
    data.students.map((s) => `
    <div class="report-card">
      <h2>${esc(s.student.name)}</h2>
      <div class="sub">${s.class ? `${esc(s.class.name)}${s.class.crebo ? ` &mdash; ${esc(s.class.crebo)}` : ""} &mdash; ` : ""}${s.student.student_number ? `Nr. ${esc(s.student.student_number)} &mdash; ` : ""}Module: ${esc(periodLabel(data.period))}</div>
      ${s.attendance ? `
      <table class="att-table">
        <thead><tr><th>Aanwezigheid</th><th>Geoorloofd afwezig</th><th>Ongeoorloofd afwezig</th></tr></thead>
        <tbody><tr>
          <td class="${s.attendance.present !== null && s.attendance.present !== undefined ? (s.attendance.present >= 85 ? "val-vol" : "val-onv") : ""}">${fmtPct(s.attendance.present)}</td>
          <td class="att-allowed">${fmtPct(s.attendance.absent_allowed)}</td>
          <td class="val-onv">${fmtPct(s.attendance.absent_unallowed)}</td>
        </tr></tbody>
      </table>` : ""}
      ${s.notes && (s.notes.comment || (audience !== "student" && s.notes.teacher_comment)) ? `
      <div class="notes-block">
        ${s.notes.comment ? `<p><strong>Opmerkingen:</strong> ${esc(s.notes.comment)}</p>` : ""}
        ${audience !== "student" && s.notes.teacher_comment ? `<p><strong>Opmerking docenten:</strong> ${esc(s.notes.teacher_comment)}</p>` : ""}
      </div>` : ""}
      ${s.keuzedelen && s.keuzedelen.length ? `
      <div class="kd-report">
        <h3>Keuzedelen (${s.sbu_total} van ${s.sbu_doel} SBU)</h3>
        <table>
          <thead><tr><th>Keuzedeel</th><th>SBU</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
          <tbody>
            ${s.keuzedelen.map((k) => `
            <tr>
              <td>${esc(k.name)}</td>
              <td>${k.sbu}</td>
              <td class="${k.value ? (k.value === "VS" ? "val-vs" : (k.tekorten > 0 ? "val-onv" : "val-vol")) : ""}">${esc(k.value)}</td>
              <td>${k.tekorten}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : ""}
      ${s.entries.length ? `
      <table>
        <thead><tr><th>Vak</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
        <tbody>
          ${s.entries.map((e) => `
          <tr>
            <td>${esc(e.subject)}</td>
            <td class="${e.value ? (e.value === "VS" ? "val-vs" : (e.tekorten > 0 ? "val-onv" : "val-vol")) : ""}">${esc(e.value)}</td>
            <td>${e.tekorten}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr><td colspan="2">Totaal tekorten</td><td>${s.total_tekorten}</td></tr></tfoot>
      </table>` : `<p>Geen cijfers bekend in deze module.</p>`}
    </div>`).join("");
}

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
  $("#kd-table tbody").innerHTML = keuzedelenList.length
    ? keuzedelenList.map((k) => `
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
    : `<tr><td colspan="6" class="hint">Nog geen keuzedelen. Voeg ze hierboven toe.</td></tr>`;
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

function statStudentOptions() {
  const classFilter = $("#stat-class") ? $("#stat-class").value : "";
  const cohortFilter = $("#stat-cohort") ? $("#stat-cohort").value : "";
  let list = students;
  if (classFilter) {
    list = list.filter((s) => String(s.class_id) === classFilter);
  } else if (cohortFilter) {
    const cls = new Map(classes.map((c) => [c.id, c]));
    list = list.filter((s) => {
      const c = cls.get(s.class_id);
      return c && String(c.cohort_id) === cohortFilter;
    });
  }
  const cls = new Map(classes.map((c) => [c.id, c]));
  const byClass = new Map();
  for (const s of list) {
    const key = s.class_id ? (cls.get(s.class_id) || {}).name || "Zonder klas" : "Zonder klas";
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(s);
  }
  let out = `<option value="">Alle studenten</option>`;
  for (const [cname, group] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0], "nl"))) {
    out += `<optgroup label="${esc(cname)}">` + group.map((s) =>
      `<option value="${s.id}">${esc(studentName(s))}${s.student_number ? ` (${esc(s.student_number)})` : ""}</option>`).join("") + `</optgroup>`;
  }
  return out;
}

function fillStatFilters() {
  const years = [...new Set(periods.map((p) => p.year || "").filter(Boolean))].sort();
  refillKeepingValue("#stat-year", `<option value="">Alle leerjaren</option>` +
    years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join(""));
  refillKeepingValue("#stat-period", statPeriodOptions());
  refillKeepingValue("#stat-student", statStudentOptions());
  refillKeepingValue("#stat-cohort", `<option value="">Alle cohorten</option>` +
    cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(""));
  refillKeepingValue("#stat-class", `<option value="">Alle klassen</option>` +
    classes.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join(""));
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
  } else if (report === "resultaten") {
    title = "Alle bewaarde resultaten per student";
    table = data.report_rows.length ? data.report_rows.map((r) => `
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
        </table>`).join("")}`).join("")
      : `<p class="hint">Geen bewaarde resultaten in deze selectie.</p>`;
  } else if (report === "keuzedelen") {
    title = "Missende keuzedelen (minder dan 720 SBU gekoppeld)";
    table = data.report_rows.length ? `
      <table class="list">
        <thead><tr><th>Student</th><th>Nr.</th><th>Klas</th><th>SBU gekoppeld</th><th>SBU tekort</th><th>Gekoppelde keuzedelen</th></tr></thead>
        <tbody>${data.report_rows.map((r) => `
          <tr>
            <td>${esc(r.student)}</td><td>${esc(r.student_number || "")}</td><td>${esc(r.class)}</td>
            <td class="val-onv">${r.sbu} / 720</td><td class="val-onv">${r.tekort}</td>
            <td>${esc(r.keuzedelen)}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="hint">Alle studenten in deze selectie hebben 720 SBU of meer aan keuzedelen.</p>`;
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
  $("#stat-output").innerHTML = header + table +
    `<p><a href="#" id="stat-back">&larr; Terug naar het overzicht</a></p>`;
  const back = $("#stat-back");
  if (back) back.addEventListener("click", (e) => {
    e.preventDefault();
    $("#stat-report").value = "";
    showStatistics();
  });
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
const statSort = {};

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
  const subjects = pageSlice("#stat-subjects-table", statSortRows("stat-subjects-table", data.subjects));
  const signals = pageSlice("#stat-signals-table", statSortRows("stat-signals-table", data.signals));
  const classes = statSortRows("stat-classes-table", data.classes);
  let html = `<h2>Statistieken — ${esc(periodLabel(data.period))}</h2>`;
  // Vakken
  html += `<h3>Vakken</h3>` + (data.subjects.length ? `
    <table class="list sortable" id="stat-subjects-table">
      <thead><tr>${statTh("stat-subjects-table", "name", "Vak")}${statTh("stat-subjects-table", "count", "Beoordelingen")}${statTh("stat-subjects-table", "avg", "Gemiddeld cijfer")}${statTh("stat-subjects-table", "vol", "Voldoendes")}${statTh("stat-subjects-table", "onv", "Onvoldoendes")}${statTh("stat-subjects-table", "vs", "VS")}${statTh("stat-subjects-table", "tekorten", "Tekorten")}</tr></thead>
      <tbody>${subjects.map((s) => `
        <tr>
          <td><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" title="Toon alle beoordelingen voor dit vak">${esc(s.name)}</a></td>
          <td><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" title="Toon alle beoordelingen voor dit vak">${s.count}</a></td><td>${avg(s.avg)}</td>
          <td class="val-vol"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="voldoendes" title="Toon de voldoendes voor dit vak">${s.vol}</a></td>
          <td class="${s.onv > 0 ? "val-onv" : ""}"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="onvoldoendes" title="Toon de onvoldoendes voor dit vak">${s.onv}</a></td>
          <td class="val-vs"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="vs" title="Toon de vrijstellingen voor dit vak">${s.vs}</a></td>
          <td class="${s.tekorten > 0 ? "val-onv" : ""}"><a href="#" class="stat-drill" data-drill="detail" data-subject="${s.id}" data-filter="onvoldoendes" title="Toon de onvoldoendes voor dit vak">${s.tekorten}</a></td>
        </tr>`).join("")}</tbody>
    </table><div class="pager" data-table="stat-subjects-table"></div>` : `<p class="hint">Geen vakken met cijfers in deze module.</p>`);
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
          <td class="${c.attendance_avg !== null && c.attendance_avg < 85 ? "val-onv" : "val-vol"}">${pct(c.attendance_avg)}</td>
          <td class="${c.attendance_low > 0 ? "val-onv" : ""}">${c.attendance_low > 0 ? `<a href="#" class="stat-drill" data-drill="aanwezigheid" data-class="${c.class_id}" title="Toon deze studenten">${c.attendance_low}</a>` : c.attendance_low}</td>
        </tr>`).join("")}</tbody>
    </table>`;
  }
  // Signalering
  html += `<h3>Signalering</h3>` + (data.signals.length ? `
    <table class="list sortable" id="stat-signals-table">
      <thead><tr>${statTh("stat-signals-table", "student", "Student")}${statTh("stat-signals-table", "student_number", "Nr.")}${statTh("stat-signals-table", "class", "Klas")}${statTh("stat-signals-table", "tekorten", "Tekorten (module)")}${statTh("stat-signals-table", "present", "Aanwezigheid")}${statTh("stat-signals-table", "sbu", "SBU keuzedelen")}${statTh("stat-signals-table", "reasons", "Signalen")}</tr></thead>
      <tbody>${signals.map((s) => `
        <tr>
          <td>${esc(s.student)}</td><td>${esc(s.student_number || "")}</td><td>${esc(s.class)}</td>
          <td class="${s.tekorten >= 3 ? "val-onv" : ""}">${s.tekorten}</td>
          <td class="${s.present !== null && s.present < 85 ? "val-onv" : ""}">${pct(s.present)}</td>
          <td class="${s.sbu < 720 ? "val-onv" : "val-vol"}">${s.sbu} / 720</td>
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

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "archief") renderArchive();
    if (btn.dataset.tab === "logboek") renderAuditLog();
    if (btn.dataset.tab === "keuzedelen") renderKeuzedelenTab();
    if (btn.dataset.tab === "statistieken") fillStatFilters();
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
  renderAuditTable();
}

function renderAuditTable() {
  const q = ($("#log-search").value || "").trim().toLowerCase();
  let rows = auditEntries;
  if (q) {
    rows = rows.filter((r) =>
      (r.username || "").toLowerCase().includes(q) ||
      (r.action || "").toLowerCase().includes(q) ||
      (r.entity || "").toLowerCase().includes(q) ||
      (r.detail || "").toLowerCase().includes(q));
  }
  rows = sortRows(rows, auditSort, (r, key) => key === "ts" ? r[key] : (r[key] || ""));
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
}

$("#import-users-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const res = await api("/api/users/import", {
      method: "POST",
      body: (() => { const fd = new FormData(); fd.append("file", file); return fd; })(),
    });
    const el = $("#users-import-result");
    el.classList.remove("hidden");
    let msg = `Toegevoegd: ${res.imported}`;
    if (res.skipped) msg += `, overgeslagen (bestaat al): ${res.skipped}`;
    if (res.errors && res.errors.length) msg += "\nFouten:\n" + res.errors.join("\n");
    el.textContent = msg;
    await loadAll();
  } catch (err) {
    alert("Import mislukt: " + err.message);
  }
  e.target.value = "";
});

$("#btn-add-user").addEventListener("click", async () => {
  const username = $("#user-username").value.trim();
  const password = $("#user-password").value;
  const role = $("#user-role").value;
  if (!username || !password) return alert("Vul gebruikersnaam en wachtwoord in.");
  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username, password, role,
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init().catch((e) => alert("Laden mislukt: " + e.message));
