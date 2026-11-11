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
  grades: { key: "name", dir: 1 },
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
  beheerder: ["cijfers", "studenten", "klassen", "vakken", "periodes", "rapport", "archief", "gebruikers"],
  mentor: ["cijfers", "studenten", "rapport", "archief"],
  docent: ["cijfers", "rapport"],
  administratie: ["rapport"],
  student: ["rapport"],
};

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
  const lt = c && c.leertraject_id
    ? leertrajecten.find((t) => t.id === c.leertraject_id) : null;
  if (!lt || !(lt.period_ids || []).length) return periods;
  return periods.filter((p) => lt.period_ids.includes(p.id));
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
    reportSel.innerHTML = (isStudent ? `<option value="all">Alle modules (totaal)</option>` : "") +
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
    classes.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
}

function renderClassSelects() {
  const cohortFilter = $("#grade-cohort").value;
  const visibleClasses = cohortFilter
    ? classes.filter((c) => String(c.cohort_id) === cohortFilter)
    : classes;
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
  return subjects.filter((s) =>
    (s.period_ids || []).includes(currentPeriod) &&
    (!classId || !(s.class_ids || []).length || s.class_ids.includes(classId))
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
function renderGradeTable() {
  const thead = $("#grade-table thead");
  const tbody = $("#grade-table tbody");
  if (!subjects.length || !students.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td>Voeg eerst ${subjects.length ? "studenten" : "vakken"} toe.</td></tr>`;
    return;
  }
  const periodSubjects = subjectsForPeriod();
  const typeShort = { cijfer: "1-10", letter: "V/G/O/VS", vnv: "V/NV" };
  thead.innerHTML = `<tr><th data-key="name">Student</th>` +
    periodSubjects.map((s) => `<th title="Beoordeling: ${typeShort[s.assessment_type] || "1-10"}">${esc(s.name)}<br><small>${typeShort[s.assessment_type] || "1-10"}</small></th>`).join("") +
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
    key === "tekorten" ? String(tekortTotal(st)).padStart(3, "0") : st.name);
  tbody.innerHTML = pageSlice("#grade-table", gradeRows).map((st) => {
    let total = 0;
    const cells = periodSubjects.map((su) => {
      const key = `${st.id}:${su.id}`;
      const v = grades[key] || "";
      total += tekorten(v);
      const cls = v && tekorten(v) > 0 ? ` class="tekort-${tekorten(v)}"` : "";
      const kind = gradeKind(v);
      return `<td${cls}><input class="cell${kind ? " val-" + kind : ""}" data-sid="${st.id}" data-suid="${su.id}" value="${esc(v)}"></td>`;
    }).join("");
    const att = attendance[st.id] || {};
    const attCell = (field, cls) => {
      const v = att[field] === null || att[field] === undefined ? "" : att[field];
      const kind = cls === "att-present" && v !== "" && parseFloat(v) < 85 ? " att-onv" : "";
      return `<td><input class="cell ${cls}${kind}" data-att="${field}" data-sid="${st.id}" value="${esc(v)}"></td>`;
    };
    return `<tr><td>${esc(st.name)}${st.student_number ? ` <small>(${esc(st.student_number)})</small>` : ""}</td>${cells}` +
      attCell("present", "att-present") +
      attCell("absent_allowed", "att-allowed") +
      attCell("absent_unallowed", "att-unallowed") +
      `<td><input class="cell note-cell" data-note="comment" data-sid="${st.id}" value="${esc((notes[st.id] || {}).comment || "")}"></td>` +
      `<td><input class="cell note-cell" data-note="teacher_comment" data-sid="${st.id}" value="${esc((notes[st.id] || {}).teacher_comment || "")}"></td>` +
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
    listSort.grades, (st, key) => key === "tekorten" ? "" : studentName(st));
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
    key === "name" ? studentName(s)
    : key === "class" ? classOf(s)
    : key === "login_enabled" ? (s.login_enabled ? "1" : "0")
    : s[key]);
  updateSortArrows("#students-table", listSort.students);
  $("#students-table tbody").innerHTML = pageSlice("#students-table", rows).map((s) => `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="row-select" data-id="${s.id}"></td>
      <td><input data-field="first_name" value="${esc(s.first_name || "")}" style="width:110px" title="${esc(s.prefix || "")}"></td>
      <td><input data-field="student_number" value="${esc(s.student_number || "")}" style="width:90px"></td>
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
  s[e.target.dataset.field] = e.target.value === "" ? null : e.target.value;
  await api(`/api/students/${s.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
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
      <td><select data-field="crebo_id">${creboOptions(c.crebo_id)}</select></td>
      <td title="Startcohort komt van het leertraject">${esc(c.cohort || "")}</td>
      <td><select data-field="leertraject_id">${ltOptions(c.leertraject_id)}</select></td>
      ${users.length ? `<td><select data-field="mentor_id">${optList(c.mentor_id, users.filter((u) => u.role === "mentor" || u.role === "beheerder").map((u) => ({ id: u.id, name: u.username })), "Geen mentor")}</select></td>` : `<td>${esc(c.mentor || "")}</td>`}
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
  $("#class-crebo").innerHTML = creboOptions("");
  $("#class-leertraject").innerHTML = ltOptions("");
  $("#lt-crebo").innerHTML = creboOptions("");
  $("#lt-cohort").innerHTML = optList("", cohorts, "Geen cohort");
  const prevLt = $("#lt-manage").value;
  $("#lt-manage").innerHTML = leertrajecten.length
    ? leertrajecten.map((t) => `<option value="${t.id}">${esc(ltLabel(t))}</option>`).join("")
    : `<option value="">(geen leertrajecten)</option>`;
  if (prevLt && leertrajecten.some((t) => String(t.id) === prevLt)) $("#lt-manage").value = prevLt;
  renderLtPeriods();
  $("#crebo-manage").innerHTML = crebos.length
    ? crebos.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("")
    : `<option value="">(geen crebos)</option>`;
  $("#cohort-manage").innerHTML = cohorts.length
    ? cohorts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")
    : `<option value="">(geen cohorten)</option>`;
}

$("#btn-add-class").addEventListener("click", async () => {
  const name = $("#class-name").value.trim();
  if (!name) return;
  await api("/api/classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      crebo_id: $("#class-crebo").value || null,
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

function renderLtPeriods() {
  const id = $("#lt-manage").value;
  const lt = leertrajecten.find((t) => String(t.id) === String(id));
  const wrap = $("#lt-periods");
  if (!lt) { wrap.innerHTML = ""; return; }
  const years = {};
  for (const p of periods) {
    const y = p.year || "Zonder studiejaar";
    (years[y] = years[y] || []).push(p);
  }
  wrap.innerHTML = `<p class="hint">Modules van leertraject <strong>${esc(ltLabel(lt))}</strong>:</p>` +
    Object.entries(years).map(([year, mods]) => {
      const anyChecked = mods.some((p) => (lt.period_ids || []).includes(p.id));
      return `
      <details class="year-group"${anyChecked ? " open" : ""}>
        <summary>${esc(year)}${anyChecked ? ` <span class="badge">${mods.filter((p) => (lt.period_ids || []).includes(p.id)).length}</span>` : ""}</summary>
        <div class="year-modules">${mods.map((p) => `
          <label class="check"><input type="checkbox" data-lt-period="${p.id}"${(lt.period_ids || []).includes(p.id) ? " checked" : ""}> ${esc(p.name)}</label>`).join("")}</div>
      </details>`;
    }).join("");
}

$("#lt-manage").addEventListener("change", () => {
  const lt = leertrajecten.find((t) => String(t.id) === $("#lt-manage").value);
  $("#lt-cohort").value = lt && lt.cohort_id ? lt.cohort_id : "";
  renderLtPeriods();
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

$("#lt-periods").addEventListener("change", async (e) => {
  const id = $("#lt-manage").value;
  if (!id || e.target.dataset.ltPeriod === undefined) return;
  const ids = [...$$("#lt-periods input[data-lt-period]:checked")].map((cb) => +cb.dataset.ltPeriod);
  try {
    await api(`/api/leertrajecten/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period_ids: ids }),
    });
    await loadAll();
  } catch (err) {
    alert("Modules opslaan mislukt: " + err.message);
  }
});

$("#btn-add-lt").addEventListener("click", async () => {
  const name = $("#lt-name").value.trim();
  if (!name) return alert("Vul eerst een naam in (bijv. ICT 2-jarig).");
  try {
    await api("/api/leertrajecten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, crebo_id: $("#lt-crebo").value || null,
                             cohort_id: $("#lt-cohort").value || null }),
    });
    $("#lt-name").value = "";
    await loadAll();
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
  if (!confirm("Crebo verwijderen? Klassen met dit crebo verliezen hun crebo.")) return;
  await api(`/api/crebos/${id}`, { method: "DELETE" });
  await loadAll();
});

$("#classes-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const c = classes.find((x) => x.id === +tr.dataset.id);
  if (!c) return;
  c[e.target.dataset.field] = e.target.value === "" ? null : e.target.value;
  await api(`/api/classes/${c.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c),
  });
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
  const visible = q ? subjects.filter((s) => s.name.toLowerCase().includes(q)) : subjects;
  const years = {};
  for (const p of periods) {
    const y = p.year || "Zonder studiejaar";
    (years[y] = years[y] || []).push(p);
  }
  const crebos = {};
  for (const c of classes) {
    const n = c.crebo || "Zonder crebo";
    (crebos[n] = crebos[n] || []).push(c);
  }
  const classChecks = (s) => Object.entries(crebos).map(([niveau, cls]) => {
    const checkedCount = cls.filter((c) => (s.class_ids || []).includes(c.id)).length;
    const anyChecked = checkedCount > 0;
    const allChecked = checkedCount === cls.length;
    return `
      <details class="year-group"${anyChecked ? " open" : ""}>
        <summary>${esc(niveau)}${anyChecked ? ` <span class="badge">${checkedCount}</span>` : ""}</summary>
        <div class="year-modules">
          <label class="check check-all"><input type="checkbox" data-classgroup="1"${allChecked ? " checked" : ""}> <em>Heel crebo</em></label>
          ${cls.map((c) => `
          <label class="check"><input type="checkbox" data-class="${c.id}"${(s.class_ids || []).includes(c.id) ? " checked" : ""}> ${esc(c.name)}</label>`).join("")}
        </div>
      </details>`;
  }).join("");
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
      <td class="period-checks">${classChecks(s)}</td>
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
  if (e.target.dataset.classgroup !== undefined) {
    const group = e.target.closest(".year-modules");
    group.querySelectorAll("input[data-class]").forEach((cb) => {
      cb.checked = e.target.checked;
    });
  }
  if (e.target.dataset.period !== undefined || e.target.dataset.class !== undefined ||
      e.target.dataset.classgroup !== undefined) {
    const periodIds = [...tr.querySelectorAll("input[data-period]:checked")]
      .map((c) => +c.dataset.period);
    const classIds = [...tr.querySelectorAll("input[data-class]:checked")]
      .map((c) => +c.dataset.class);
    try {
      await api(`/api/subjects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_ids: periodIds, class_ids: classIds }),
      });
      const s = subjects.find((x) => x.id === +id);
      if (s) { s.period_ids = periodIds; s.class_ids = classIds; }
      renderSubjects();
      renderGradeTable();
    } catch (err) {
      alert("Opslaan van koppeling mislukt: " + err.message);
      await loadAll();
    }
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
    const out = $("#report-output");
    out.innerHTML = "";
    for (const p of periods) {
      const data = await api(`/api/report?period_id=${p.id}&audience=student&student_id=${currentUser.student_id}`);
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
  const unarchiveBtn = `<button class="secondary" data-unarchive>Terugzetten</button>`;
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
  });
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
  $("#users-table tbody").innerHTML = pageSlice("#users-table", users).map((u) => `
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
