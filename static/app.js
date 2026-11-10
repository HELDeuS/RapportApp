const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let students = [];
let classes = [];
let niveaus = [];
let cohorts = [];
let subjects = [];
let periods = [];
let grades = {}; // "studentId:subjectId" -> value
let attendance = {}; // studentId -> {present, absent_allowed, absent_unallowed}
let notes = {}; // studentId -> {comment, teacher_comment}
let currentPeriod = null;

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

// ---------- Tabs ----------
$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- Loaders ----------
async function loadAll() {
  [students, classes, niveaus, cohorts, subjects, periods] = await Promise.all([
    api("/api/students"), api("/api/classes"), api("/api/niveaus"), api("/api/cohorts"), api("/api/subjects"), api("/api/periods"),
  ]);
  students.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  classes.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  niveaus.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  subjects.sort((a, b) => a.name.localeCompare(b.name, "nl"));
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

function renderPeriodSelects() {
  for (const sel of [$("#grade-period"), $("#report-period")]) {
    sel.innerHTML = periods.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join("");
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

function classLabel(c) {
  return c.niveau ? `${c.name} (${c.niveau})` : c.name;
}

function visibleStudents() {
  const classId = $("#grade-class").value;
  return classId ? students.filter((s) => String(s.class_id) === classId) : students;
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
  thead.innerHTML = `<tr><th>Student</th>` +
    periodSubjects.map((s) => `<th>${esc(s.name)}</th>`).join("") +
    `<th title="Aanwezigheid">Aanw. %</th>` +
    `<th title="Geoorloofd afwezig">Geoorl. afw. %</th>` +
    `<th title="Ongeoorloofd afwezig">Ongeoorl. afw. %</th>` +
    `<th title="Opmerkingen (zichtbaar op studentrapport)">Opmerkingen</th>` +
    `<th title="Opmerking docenten (alleen op docentenrapport)">Opm. docenten</th>` +
    `<th>Tekorten</th></tr>`;

  tbody.innerHTML = visibleStudents().map((st) => {
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
  if (v === "O") return 1;
  const n = Math.round(parseFloat(v));
  return n < 6 ? 6 - n : 0;
}

function gradeKind(v) {
  if (!v) return "";
  if (v === "VS") return "vs";
  if (v === "O" || tekorten(v) > 0) return "onv";
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

$("#grade-class").addEventListener("change", () => renderGradeTable());

$("#grade-cohort").addEventListener("change", () => {
  renderClassSelects();
  renderGradeTable();
});

$("#student-search").addEventListener("input", renderStudents);
$("#student-cohort").addEventListener("change", renderStudents);
$("#student-class-filter").addEventListener("change", renderStudents);

// ---------- Import: bestand ----------
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !currentPeriod) return;
  const fd = new FormData();
  fd.append("period_id", currentPeriod);
  fd.append("file", file);
  fd.append("create_missing", $("#create-missing").checked ? "1" : "0");
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
$("#btn-paste-open").addEventListener("click", () => {
  $("#paste-dialog").classList.remove("hidden");
  $("#paste-area").value = "";
  $("#paste-area").focus();
});
$("#btn-paste-cancel").addEventListener("click", () => $("#paste-dialog").classList.add("hidden"));
$("#btn-paste-import").addEventListener("click", async () => {
  const text = $("#paste-area").value.trim();
  if (!text || !currentPeriod) return;
  const fd = new FormData();
  fd.append("period_id", currentPeriod);
  fd.append("text", text);
  fd.append("create_missing", $("#create-missing").checked ? "1" : "0");
  try {
    const res = await api("/api/import", { method: "POST", body: fd });
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
  if (res.new_subjects && res.new_subjects.length) msg += `\nNieuwe vakken: ${res.new_subjects.join(", ")}`;
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
  $("#students-table tbody").innerHTML = visibleStudentsList().map((s) => `
    <tr data-id="${s.id}">
      <td><input data-field="name" value="${esc(s.name)}"></td>
      <td><input data-field="student_number" value="${esc(s.student_number || "")}"></td>
      <td><select data-field="class_id">${classOptions(s.class_id)}</select></td>
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
}

$("#btn-add-student").addEventListener("click", async () => {
  const name = $("#student-name").value.trim();
  if (!name) return;
  await api("/api/students", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      student_number: $("#student-number").value.trim(),
      class_id: $("#student-class").value || null,
    }),
  });
  $("#student-name").value = "";
  $("#student-number").value = "";
  await loadAll();
});

$("#students-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const s = students.find((x) => x.id === +tr.dataset.id);
  if (!s) return;
  s[e.target.dataset.field] = e.target.value === "" ? null : e.target.value;
  await api(`/api/students/${s.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
});

// ---------- Klassen ----------
function niveauOptions(sel) {
  return `<option value="">Geen niveau</option>` +
    niveaus.map((n) => `<option value="${n.id}"${String(sel) === String(n.id) ? " selected" : ""}>${esc(n.name)}</option>`).join("");
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
  $("#classes-table tbody").innerHTML = classes.map((c) => `
    <tr data-id="${c.id}">
      <td><input data-field="name" value="${esc(c.name)}"></td>
      <td><select data-field="niveau_id">${niveauOptions(c.niveau_id)}</select></td>
      <td><select data-field="cohort_id">${optList(c.cohort_id, cohorts, "Geen cohort")}</select></td>
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
  $("#class-niveau").innerHTML = niveauOptions("");
  $("#class-cohort").innerHTML = optList("", cohorts, "Geen cohort");
  $("#niveau-manage").innerHTML = niveaus.length
    ? niveaus.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("")
    : `<option value="">(geen niveaus)</option>`;
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
      niveau_id: $("#class-niveau").value || null,
      cohort_id: $("#class-cohort").value || null,
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

$("#btn-add-niveau").addEventListener("click", async () => {
  const name = $("#niveau-name").value.trim();
  if (!name) return;
  await api("/api/niveaus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  $("#niveau-name").value = "";
  await loadAll();
});

$("#btn-del-niveau").addEventListener("click", async () => {
  const id = $("#niveau-manage").value;
  if (!id) return;
  if (!confirm("Niveau verwijderen? Klassen met dit niveau verliezen hun niveau.")) return;
  await api(`/api/niveaus/${id}`, { method: "DELETE" });
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
  const niveaus = {};
  for (const c of classes) {
    const n = c.niveau || "Zonder niveau";
    (niveaus[n] = niveaus[n] || []).push(c);
  }
  const classChecks = (s) => Object.entries(niveaus).map(([niveau, cls]) => {
    const checkedCount = cls.filter((c) => (s.class_ids || []).includes(c.id)).length;
    const anyChecked = checkedCount > 0;
    const allChecked = checkedCount === cls.length;
    return `
      <details class="year-group"${anyChecked ? " open" : ""}>
        <summary>${esc(niveau)}${anyChecked ? ` <span class="badge">${checkedCount}</span>` : ""}</summary>
        <div class="year-modules">
          <label class="check check-all"><input type="checkbox" data-classgroup="1"${allChecked ? " checked" : ""}> <em>Heel niveau</em></label>
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
  $("#subjects-table tbody").innerHTML = visible.map((s) => `
    <tr data-id="${s.id}">
      <td><input data-field="name" value="${esc(s.name)}"></td>
      <td class="period-checks">${checks(s)}</td>
      <td class="period-checks">${classChecks(s)}</td>
      <td><button class="secondary" data-archive>Archiveren</button></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
}

$("#subject-filter").addEventListener("input", renderSubjects);

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
  $("#periods-table tbody").innerHTML = periods.map((p) => `
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
  const studentId = $("#report-student").value;
  const classId = $("#report-class").value;
  const cohortId = $("#report-cohort").value;
  const audience = $("#report-audience").value;
  let url = `/api/report?period_id=${periodId}&audience=${audience}`;
  if (studentId) url += `&student_id=${studentId}`;
  if (classId) url += `&class_id=${classId}`;
  if (cohortId) url += `&cohort_id=${cohortId}`;
  const data = await api(url);
  const out = $("#report-output");
  out.innerHTML = data.students.map((s) => `
    <div class="report-card">
      <h2>${esc(s.student.name)}</h2>
      <div class="sub">${s.class ? `${esc(s.class.name)}${s.class.niveau ? ` &mdash; ${esc(s.class.niveau)}` : ""} &mdash; ` : ""}${s.student.student_number ? `Nr. ${esc(s.student.student_number)} &mdash; ` : ""}Module: ${esc(periodLabel(data.period))}</div>
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
  "arch-classes-table": { search: "arch-classes-search", cols: ["name", "niveau", "cohort"], empty: 4 },
  "arch-subjects-table": { search: "arch-subjects-search", cols: ["name"], empty: 2 },
  "arch-cohorts-table": { search: "arch-cohorts-search", cols: ["name"], empty: 2 },
};

async function renderArchive() {
  const [archStudents, archClasses, archSubjects, archCohorts] = await Promise.all([
    api("/api/students?archived=1"), api("/api/classes?archived=1"),
    api("/api/subjects?archived=1"), api("/api/cohorts?archived=1"),
  ]);
  archiveData = {
    "arch-students-table": archStudents,
    "arch-classes-table": archClasses,
    "arch-subjects-table": archSubjects,
    "arch-cohorts-table": archCohorts,
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
    const base = th.textContent.replace(/ [\u25B4\u25BE]$/, "");
    th.textContent = th.dataset.key === state.sortKey
      ? base + (state.sortDir === 1 ? " \u25BE" : " \u25B4")
      : base;
  });
  const kind = table.dataset.kind;
  const unarchiveBtn = `<button class="secondary" data-unarchive>Terugzetten</button>`;
  const cells = (r) => cfg.cols.map((c) => `<td>${esc(r[c] || "")}</td>`).join("");
  table.querySelector("tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr data-id="${r.id}" data-kind="${kind}">${cells(r)}<td>${unarchiveBtn}</td></tr>`).join("")
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

loadAll().catch((e) => alert("Laden mislukt: " + e.message));
