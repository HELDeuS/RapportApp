const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let students = [];
let classes = [];
let subjects = [];
let periods = [];
let grades = {}; // "studentId:subjectId" -> value
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
  [students, classes, subjects, periods] = await Promise.all([
    api("/api/students"), api("/api/classes"), api("/api/subjects"), api("/api/periods"),
  ]);
  students.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  classes.sort((a, b) => a.name.localeCompare(b.name, "nl"));
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
  for (const sel of [$("#grade-class"), $("#report-class")]) {
    sel.innerHTML = `<option value="">Alle klassen</option>` +
      classes.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
  }
  $("#student-class").innerHTML = `<option value="">Geen klas</option>` +
    classes.map((c) => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join("");
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
  return subjects.filter((s) => (s.period_ids || []).includes(currentPeriod));
}

async function loadGrades() {
  if (!currentPeriod) { renderGradeTable(); return; }
  const rows = await api(`/api/grades?period_id=${currentPeriod}`);
  grades = {};
  for (const r of rows) grades[`${r.student_id}:${r.subject_id}`] = r.value;
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
    `<th>Tekorten</th></tr>`;

  tbody.innerHTML = visibleStudents().map((st) => {
    let total = 0;
    const cells = periodSubjects.map((su) => {
      const key = `${st.id}:${su.id}`;
      const v = grades[key] || "";
      total += tekorten(v);
      const cls = v && tekorten(v) > 0 ? ` class="tekort-${tekorten(v)}"` : "";
      return `<td${cls}><input class="cell" data-sid="${st.id}" data-suid="${su.id}" value="${esc(v)}"></td>`;
    }).join("");
    return `<tr><td>${esc(st.name)}${st.student_number ? ` <small>(${esc(st.student_number)})</small>` : ""}</td>${cells}` +
      `<td class="total" data-total="${st.id}" data-name="${esc(st.name)}">${total}</td></tr>`;
  }).join("");

  tbody.querySelectorAll("input.cell").forEach((inp) => {
    inp.addEventListener("change", () => saveCell(inp));
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
function renderStudents() {
  const classOptions = (sel) => `<option value="">Geen klas</option>` +
    classes.map((c) => `<option value="${c.id}"${String(sel) === String(c.id) ? " selected" : ""}>${esc(classLabel(c))}</option>`).join("");
  $("#students-table tbody").innerHTML = students.map((s) => `
    <tr data-id="${s.id}">
      <td><input data-field="name" value="${esc(s.name)}"></td>
      <td><input data-field="student_number" value="${esc(s.student_number || "")}"></td>
      <td><select data-field="class_id">${classOptions(s.class_id)}</select></td>
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
function renderClasses() {
  $("#classes-table tbody").innerHTML = classes.map((c) => `
    <tr data-id="${c.id}">
      <td><input data-field="name" value="${esc(c.name)}"></td>
      <td><input data-field="niveau" value="${esc(c.niveau || "")}"></td>
      <td><button class="danger" data-del>Verwijderen</button></td>
    </tr>`).join("");
}

$("#btn-add-class").addEventListener("click", async () => {
  const name = $("#class-name").value.trim();
  if (!name) return;
  await api("/api/classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, niveau: $("#class-niveau").value.trim() }),
  });
  $("#class-name").value = "";
  $("#class-niveau").value = "";
  await loadAll();
});

$("#classes-table tbody").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const c = classes.find((x) => x.id === +tr.dataset.id);
  if (!c) return;
  c[e.target.dataset.field] = e.target.value;
  await api(`/api/classes/${c.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c),
  });
  await loadAll();
});

$("#classes-table tbody").addEventListener("click", async (e) => {
  if (!e.target.dataset.del) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Klas verwijderen? Studenten blijven bestaan maar verliezen hun klas.")) return;
  await api(`/api/classes/${id}`, { method: "DELETE" });
  await loadAll();
});

$("#students-table tbody").addEventListener("click", async (e) => {
  if (!e.target.dataset.del) return;
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
      if (s) s.period_ids = periodIds;
      renderSubjects();
      renderGradeTable();
    } catch (err) {
      alert("Opslaan van module-koppeling mislukt: " + err.message);
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
  if (!e.target.dataset.del) return;
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
  if (!e.target.dataset.del) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Module verwijderen? Alle cijfers in deze module vervallen.")) return;
  await api(`/api/periods/${id}`, { method: "DELETE" });
  await loadAll();
});

// ---------- Rapport ----------
$("#btn-report").addEventListener("click", showReport);
$("#btn-print").addEventListener("click", () => window.print());

async function showReport() {
  const periodId = $("#report-period").value;
  if (!periodId) return;
  const studentId = $("#report-student").value;
  const classId = $("#report-class").value;
  let url = `/api/report?period_id=${periodId}`;
  if (studentId) url += `&student_id=${studentId}`;
  if (classId) url += `&class_id=${classId}`;
  const data = await api(url);
  const out = $("#report-output");
  out.innerHTML = data.students.map((s) => `
    <div class="report-card">
      <h2>${esc(s.student.name)}</h2>
      <div class="sub">${s.class ? `${esc(s.class.name)}${s.class.niveau ? ` &mdash; ${esc(s.class.niveau)}` : ""} &mdash; ` : ""}${s.student.student_number ? `Nr. ${esc(s.student.student_number)} &mdash; ` : ""}Module: ${esc(periodLabel(data.period))}</div>
      ${s.entries.length ? `
      <table>
        <thead><tr><th>Vak</th><th>Beoordeling</th><th>Tekorten</th></tr></thead>
        <tbody>
          ${s.entries.map((e) => `
          <tr>
            <td>${esc(e.subject)}</td>
            <td>${esc(e.value)}</td>
            <td>${e.tekorten}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr><td colspan="2">Totaal tekorten</td><td>${s.total_tekorten}</td></tr></tfoot>
      </table>` : `<p>Geen cijfers bekend in deze module.</p>`}
    </div>`).join("");
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadAll().catch((e) => alert("Laden mislukt: " + e.message));
