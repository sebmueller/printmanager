import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyI18n, getLang, setLang, t } from "./i18n.js";

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), "Accept-Language": getLang() };
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    toast(t("error.generic", { msg: t("error.connection") }), true);
    throw new Error(t("error.connection"));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    toast(t("error.generic", { msg }), true);
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

const fmtTime = (min) => {
  min = Math.round(min || 0);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};
const fmtG = (g) => (g || 0) >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`;
const fmtBytes = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;

const STATUS_KEYS = ["geplant", "queue", "gedruckt", "montiert"];
const statusLabel = (k) => t("status." + k);
const statusOptions = (selected) =>
  STATUS_KEYS.map((k) => `<option value="${k}" ${selected === k ? "selected" : ""}>${statusLabel(k)}</option>`).join("");

// ---------------------------------------------------------------- 3D viewer

function createViewer(canvas, buffer) {
  const loader = new STLLoader();
  const geo = loader.parse(buffer);
  geo.computeVertexNormals();
  geo.center();

  const size = new THREE.Box3().setFromBufferAttribute(geo.attributes.position).getSize(new THREE.Vector3());

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 300;
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12161c);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, maxDim * 100);
  camera.position.set(1.6, 1.2, 1.6).multiplyScalar(maxDim * 0.9);

  const material = new THREE.MeshStandardMaterial({ color: 0xff9a3c, metalness: 0.1, roughness: 0.55 });
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  const grid = new THREE.GridHelper(maxDim * 2, 10, 0x2e3844, 0x232b36);
  grid.position.y = -size.y / 2;
  scene.add(grid);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.6); d1.position.set(maxDim, maxDim * 2, maxDim);
  const d2 = new THREE.DirectionalLight(0x88aaff, 0.6); d2.position.set(-maxDim, maxDim, -maxDim);
  scene.add(d1, d2);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  let raf;
  (function loop() {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  return {
    size,
    triangles: geo.attributes.position.count / 3,
    dispose() {
      cancelAnimationFrame(raf);
      controls.dispose();
      geo.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

async function loadFileBuffer(partId) {
  const res = await fetch(`/api/parts/${partId}/file`);
  if (!res.ok) throw new Error(t("preview.fileMissing"));
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- state

let currentView = "dashboard";
let currentProjectId = null;
let projectsCache = [];
let spoolsCache = [];

function showView(name) {
  currentView = name;
  for (const v of ["dashboard", "parts", "project", "queue", "spools", "archive"]) {
    $(`#view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name || (name === "project" && b.dataset.tab === "dashboard")));
  return render();
}

async function render() {
  if (currentView === "dashboard") await renderDashboard();
  else if (currentView === "parts") await renderParts();
  else if (currentView === "project") await renderProject();
  else if (currentView === "queue") await renderQueue();
  else if (currentView === "spools") await renderSpools();
  else if (currentView === "archive") await renderArchive();
}

// ---------------------------------------------------------------- dashboard

async function renderDashboard() {
  const [stats, projects] = await Promise.all([api("/api/stats"), api("/api/projects")]);
  projectsCache = projects;
  const view = $("#view-dashboard");
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">${t("dash.projects")}</h2>
      <div class="spacer"></div>
      <button class="btn" id="btn-import">${t("dash.import")}</button>
      <a class="btn" id="btn-backup" href="/api/export/full">${t("dash.backup")}</a>
      <button class="btn primary" id="btn-new-project">${t("dash.newProject")}</button>
      <p class="muted" style="margin:0">${t("dash.dropHint")}</p>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="v">${stats.projects}</div><div class="l">${t("dash.stat.projects")}</div></div>
      <div class="stat"><div class="v">${stats.copies_done}/${stats.copies}</div><div class="l">${t("dash.stat.copiesDone")}</div></div>
      <div class="stat"><div class="v">${fmtTime(stats.time_open_min)}</div><div class="l">${t("dash.stat.restTime")}</div></div>
      <div class="stat"><div class="v">${fmtG(stats.filament_open_g)}</div><div class="l">${t("dash.stat.filamentPlanned")}</div></div>
      <div class="stat"><div class="v">${fmtG(stats.spool_remaining_g)}</div><div class="l">${t("dash.stat.spoolStock")}</div></div>
    </div>
    <div class="cards">
      ${projects.map((p) => {
    const pct = p.copies_total ? Math.round(100 * p.copies_done / p.copies_total) : 0;
    return `
        <div class="card" data-project="${p.id}">
          <h3>${esc(p.name)}</h3>
          <div class="desc">${esc(p.description)}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="meta">
            <span>${t("dash.card.copies", { done: p.copies_done, total: p.copies_total, pct })}</span>
            <span>${t("dash.card.parts", { n: p.parts_count })}${p.runs > 1 ? ` · ${t("dash.card.runs", { n: p.runs })}` : ""}</span>
          </div>
          <div class="meta">
            <span>${fmtTime(p.time_open)}</span>
            <span>${fmtG(p.filament_open)}</span>
          </div>
          <div class="card-actions">
            <button class="btn small" data-archive="${p.id}" title="${t("archive.title")}">${t("archive.archive")}</button>
          </div>
        </div>`;
  }).join("") || `<div class="empty">${t("dash.empty")}</div>`}
    </div>`;
  view.querySelectorAll(".card").forEach((c) =>
    c.addEventListener("click", (e) => {
      if (e.target.closest("[data-archive]")) return;
      openProject(+c.dataset.project);
    }));
  view.querySelectorAll("[data-archive]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const project = projectsCache.find((p) => p.id === +btn.dataset.archive);
      if (!project || !confirm(t("archive.confirmArchive", { name: project.name }))) return;
      await api(`/api/projects/${project.id}`, { method: "PUT", json: { archived: 1 } });
      toast(t("archive.archived"));
      render();
    }));
  $("#btn-new-project").addEventListener("click", () => openProjectModal());
  $("#btn-import").addEventListener("click", () => $("#import-modal").showModal());
}

// ---------------------------------------------------------------- archive

async function renderArchive() {
  const archived = await api("/api/projects?archived=1");
  projectsCache = archived;
  const view = $("#view-archive");
  view.innerHTML = `
    <div class="toolbar"><h2 style="margin:0">${t("archive.title")}</h2>
      <span class="muted">${t("archive.hint")}</span><div class="spacer"></div></div>
    <div class="cards">
      ${archived.map((p) => {
    const pct = p.copies_total ? Math.round(100 * p.copies_done / p.copies_total) : 0;
    return `
        <div class="card" data-project="${p.id}">
          <h3>${esc(p.name)}</h3>
          <div class="desc">${esc(p.description)}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="meta">
            <span>${t("dash.card.copies", { done: p.copies_done, total: p.copies_total, pct })}</span>
            <span>${t("dash.card.parts", { n: p.parts_count })}${p.runs > 1 ? ` · ${t("dash.card.runs", { n: p.runs })}` : ""}</span>
          </div>
          <div class="card-actions">
            <button class="btn small" data-restore="${p.id}" title="${t("archive.restore")}">${t("archive.restore")}</button>
            <button class="btn small" data-open="${p.id}">${t("archive.open")}</button>
          </div>
        </div>`;
  }).join("") || `<div class="empty">${t("archive.empty")}</div>`}
    </div>`;
  view.querySelectorAll("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const project = archived.find((p) => p.id === +btn.dataset.restore);
      if (!project || !confirm(t("archive.confirmRestore", { name: project.name }))) return;
      await api(`/api/projects/${project.id}`, { method: "PUT", json: { archived: 0 } });
      toast(t("archive.restored"));
      renderArchive();
    }));
  view.querySelectorAll("[data-open]").forEach((btn) =>
    btn.addEventListener("click", () => openProject(+btn.dataset.open)));
}

// ---------------------------------------------------------------- import

$("#import-cancel").addEventListener("click", () => $("#import-modal").close());

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const file = form.file.files[0];
  if (!file) return;
  const mode = form.mode.value;
  if (mode === "restore" && !confirm(t("import.confirmRestore"))) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);
  try {
    const res = await api("/api/import", { method: "POST", body: fd });
    $("#import-modal").close();
    form.reset();
    toast(t("import.ok", res));
    showView("dashboard");
  } catch { /* Fehler schon als Toast gezeigt */ }
});

// ---------------------------------------------------------------- inline editing

function attachInlineEditing(view) {
  const saveField = async (el) => {
    const field = el.dataset.field || "status";
    const id = +el.dataset.id;
    let value = el.value;
    if (field === "copies") value = Math.max(1, parseInt(value) || 1);
    if (field === "priority") value = parseInt(value) || 0;
    if (field === "time_min" || field === "filament_g") value = Math.max(0, parseFloat(value) || 0);
    if (field === "spool_id") value = value ? +value : null;
    if (field === "name") {
      value = value.trim();
      if (!value) { render(); return; }
    }
    try {
      await api(`/api/parts/${id}`, { method: "PUT", json: { [field]: value } });
      el.value = value ?? "";
      if (field === "status") render();
    } catch {
      render();
    }
  };
  view.querySelectorAll("[data-field], .status-sel[data-id]").forEach((el) =>
    el.addEventListener("change", () => saveField(el)));
  view.querySelectorAll("input[data-field]").forEach((el) =>
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); }));
}

// ---------------------------------------------------------------- settings

let slicerProfilesCache = null;

async function getSlicerProfiles(force = false) {
  if (!slicerProfilesCache || force) {
    slicerProfilesCache = await api("/api/slicer/profiles");
  }
  return slicerProfilesCache;
}

function fillProfileSelect(sel, list, selectedPath) {
  sel.innerHTML = `<option value="">${t("slice.none")}</option>` +
    (list || []).map((p) =>
      `<option value="${esc(p.path)}" ${p.path === selectedPath ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

async function loadSettingsIntoForm() {
  try {
    const [s, profiles] = await Promise.all([api("/api/settings"), getSlicerProfiles()]);
    $("#settings-slicer").value = s.slicer_path || s.detected_path || "";
    const saved = s.profiles || {};
    fillProfileSelect($("#settings-machine"), profiles.machine, saved.machine || "");
    fillProfileSelect($("#settings-process"), profiles.process, saved.process || "");
    fillProfileSelect($("#settings-filament"), profiles.filament, saved.filament || "");
    $("#settings-status").textContent = s.detected_path
      ? t("settings.detected", { path: s.detected_path })
      : t("settings.none");
  } catch { /* Fehler bereits als Toast */ }
}

$("#btn-settings").addEventListener("click", async () => {
  $("#settings-status").textContent = "";
  $("#settings-modal").showModal();
  await loadSettingsIntoForm();
});

$("#settings-detect").addEventListener("click", async () => {
  try {
    const s = await api("/api/settings");
    if (s.detected_path) {
      $("#settings-slicer").value = s.detected_path;
      $("#settings-status").textContent = t("settings.detected", { path: s.detected_path });
      const profiles = await getSlicerProfiles(true);
      const saved = s.profiles || {};
      fillProfileSelect($("#settings-machine"), profiles.machine, saved.machine || "");
      fillProfileSelect($("#settings-process"), profiles.process, saved.process || "");
      fillProfileSelect($("#settings-filament"), profiles.filament, saved.filament || "");
    } else {
      $("#settings-status").textContent = t("settings.none");
    }
  } catch { /* Fehler bereits als Toast */ }
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", {
      method: "PUT",
      json: {
        slicer_path: $("#settings-slicer").value.trim(),
        profiles: {
          machine: $("#settings-machine").value,
          process: $("#settings-process").value,
          filament: $("#settings-filament").value,
        },
      },
    });
    $("#settings-modal").close();
    toast(t("settings.saved"));
  } catch { /* Fehler bereits als Toast */ }
});

// ---------------------------------------------------------------- parts (global)

let partsSortKey = "status";
let partsSortDir = 1;
let partsFilter = "alle";
const STATUS_RANK = { geplant: 0, queue: 1, gedruckt: 2, montiert: 3 };

function partDownloadButton(part) {
  if (!part.file_stored) {
    return `<button type="button" class="btn small download-btn" disabled title="${t("preview.fileMissing")}">${t("actions.downloadStl")}</button>`;
  }
  return `<a class="btn small download-btn" href="/api/parts/${part.id}/file" download="${esc(part.file_name || t("common.stlFallback"))}" title="${t("actions.downloadNamed", { name: esc(part.file_name), size: fmtBytes(part.file_size) })}">${t("actions.downloadStl")}</a>`;
}

function partSlicerButton(part) {
  if (!part.file_stored) return "";
  return `<button class="icon-btn" data-act="slicer" data-id="${part.id}" title="${t("actions.openSlicer")}">🧩</button>`;
}

function unprintButton(part) {
  if (!part.copies_printed) return "";
  return `<button class="icon-btn" data-act="unprint" data-id="${part.id}" title="${t("actions.unprint")}">−1</button>`;
}

function sliceButton(part) {
  if (!part.file_stored) return "";
  return `<button class="icon-btn" data-act="slice" data-id="${part.id}" title="${t("actions.slice")}">≈</button>`;
}

let slicePartId = null;

async function openSliceModal(part) {
  slicePartId = part.id;
  $("#slice-text").textContent = t("slice.text", { name: part.name });
  $("#slice-status").textContent = "";
  $("#slice-run").disabled = false;
  $("#slice-modal").showModal();
  try {
    const [s, profiles] = await Promise.all([api("/api/settings"), getSlicerProfiles()]);
    const saved = s.profiles || {};
    fillProfileSelect($("#slice-machine"), profiles.machine, saved.machine || "");
    fillProfileSelect($("#slice-process"), profiles.process, saved.process || "");
    fillProfileSelect($("#slice-filament"), profiles.filament, saved.filament || "");
  } catch { /* Fehler bereits als Toast */ }
}

$("#slice-run").addEventListener("click", async () => {
  const id = slicePartId;
  if (!id) return;
  const profiles = {
    machine: $("#slice-machine").value,
    process: $("#slice-process").value,
    filament: $("#slice-filament").value,
  };
  if (!profiles.machine || !profiles.process || !profiles.filament) {
    toast(t("slice.needProfiles"), true);
    return;
  }
  const btn = $("#slice-run");
  btn.disabled = true;
  $("#slice-status").textContent = t("slice.running");
  try {
    const res = await api(`/api/parts/${id}/slice`, { method: "POST", json: { profiles } });
    $("#slice-modal").close();
    toast(t("slice.done", { time: fmtTime(res.time_min), filament: fmtG(res.filament_g) }));
    render();
  } catch {
    $("#slice-status").textContent = "";
  } finally {
    btn.disabled = false;
  }
});

let unprintPartId = null;

function openUnprintModal(part) {
  unprintPartId = part.id;
  $("#unprint-text").textContent = t("unprint.text", { name: part.name });
  $("#unprint-modal").showModal();
}

async function doUnprint(refund) {
  const id = unprintPartId;
  if (!id) return;
  $("#unprint-modal").close();
  await api(`/api/parts/${id}/unprint`, { json: { copies: 1, refund } });
  toast(t(refund ? "actions.unprintRefunded" : "actions.unprintWasted"));
  render();
}

$("#unprint-waste").addEventListener("click", () => doUnprint(false));
$("#unprint-refund").addEventListener("click", () => doUnprint(true));

async function openPart(id) {
  partsFilter = "alle";
  currentProjectId = null;
  await showView("parts");
  const row = $(`#view-parts tr[data-part-id="${id}"]`);
  if (!row) return;
  row.classList.add("part-target");
  row.querySelector('input[data-field="name"]').focus({ preventScroll: true });
  row.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function renderParts() {
  const [parts, projects, spools] = await Promise.all([
    api("/api/parts"), api("/api/projects"), api("/api/spools"),
  ]);
  spoolsCache = spools;
  let list = [...parts];
  if (partsFilter === "offen") list = list.filter((p) => STATUS_RANK[p.status] <= 1);
  else if (partsFilter !== "alle") list = list.filter((p) => p.status === partsFilter);

  const val = (p) => {
    switch (partsSortKey) {
      case "name": return p.name.toLowerCase();
      case "copies": return p.copies;
      case "printed": return p.copies_printed;
      case "time": return p.time_min * p.copies * (p.project_runs || 1);
      case "filament": return p.filament_g * p.copies * (p.project_runs || 1);
      case "color": return (p.spool_color || "~").toLowerCase();
      case "status": return STATUS_RANK[p.status];
      case "priority": return p.priority;
      default: return 0;
    }
  };
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : (a.id - b.id)) * partsSortDir;
  });

  const groups = [];
  const groupMap = new Map();
  for (const p of list) {
    let g = groupMap.get(p.project_id);
    if (!g) {
      g = { id: p.project_id, name: p.project_name || "?", items: [] };
      groupMap.set(p.project_id, g);
      groups.push(g);
    }
    g.items.push(p);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, getLang() === "de" ? "de" : "en"));

  const open = list.filter((p) => p.copies_printed < p.copies * (p.project_runs || 1));
  const sumTime = open.reduce((s, p) => s + p.time_min * (p.copies * (p.project_runs || 1) - p.copies_printed), 0);
  const sumFil = open.reduce((s, p) => s + p.filament_g * (p.copies * (p.project_runs || 1) - p.copies_printed), 0);
  const arrow = (k) => partsSortKey === k ? (partsSortDir === 1 ? " ▲" : " ▼") : "";

  const view = $("#view-parts");
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">${t("parts.title")} <span class="muted">(${list.length})</span></h2>
      <span class="muted">${t("parts.summary", { n: open.length, time: fmtTime(sumTime), fil: fmtG(sumFil) })}</span>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-add-part-global">${t("project.addPart")}</button>
      <label class="muted" style="display:flex;align-items:center;gap:6px">${t("parts.filter")}
        <select class="status-sel" id="parts-filter">
          <option value="alle" ${partsFilter === "alle" ? "selected" : ""}>${t("parts.all")}</option>
          <option value="offen" ${partsFilter === "offen" ? "selected" : ""}>${t("parts.onlyOpen")}</option>
          ${statusOptions(partsFilter)}
        </select>
      </label>
    </div>
    <table>
      <thead><tr>
        <th class="sortable" data-sort="name">${t("table.name")}${arrow("name")}</th>
        <th class="sortable num" data-sort="copies">${t("table.copies")}${arrow("copies")}</th>
        <th class="sortable num" data-sort="printed">${t("table.printed")}${arrow("printed")}</th>
        <th class="sortable" data-sort="status">${t("table.status")}${arrow("status")}</th>
        <th class="sortable num" data-sort="time">${t("part.timePerCopy")}${arrow("time")}</th>
        <th class="sortable num" data-sort="filament">${t("part.filamentPerCopy")}${arrow("filament")}</th>
        <th class="sortable" data-sort="color">${t("table.spool")}${arrow("color")}</th>
        <th class="sortable num" data-sort="priority">${t("table.priority")}${arrow("priority")}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${groups.map((g) => `
        <tr class="group-row">
          <td colspan="9">
            <a href="#" class="proj-link" data-project="${g.id}">${esc(g.name)}</a>
            <span class="muted">${t("dash.card.parts", { n: g.items.length })}</span>
          </td>
        </tr>
        ${g.items.map((p) => `
        <tr data-part-id="${p.id}">
          <td>
            <input class="inline-input w-name" type="text" data-id="${p.id}" data-field="name" value="${esc(p.name)}">
            ${p.notes ? `<span class="muted" title="${esc(p.notes)}"> 📝</span>` : ""}
          </td>
          <td class="num"><input class="inline-input w-num" type="number" min="1" step="1" data-id="${p.id}" data-field="copies" value="${p.copies}" title="${t("table.totalCopies")}: ${p.copies * (p.project_runs || 1)}"></td>
          <td class="num">${p.copies_printed} / ${p.copies * (p.project_runs || 1)}</td>
          <td><select class="status-sel" data-id="${p.id}">${statusOptions(p.status)}</select></td>
          <td class="num"><input class="inline-input w-num" type="number" min="0" step="1" data-id="${p.id}" data-field="time_min" value="${p.time_min}" title="${t("table.time")}: ${fmtTime(p.time_min * p.copies * (p.project_runs || 1))}"></td>
          <td class="num"><input class="inline-input w-num" type="number" min="0" step="0.1" data-id="${p.id}" data-field="filament_g" value="${p.filament_g}" title="${t("table.filament")}: ${fmtG(p.filament_g * p.copies * (p.project_runs || 1))}"></td>
          <td><select class="status-sel" data-id="${p.id}" data-field="spool_id">${spoolOptions(p.spool_id)}</select></td>
          <td class="num"><input class="inline-input w-prio" type="number" step="1" data-id="${p.id}" data-field="priority" value="${p.priority}"></td>
          <td><div class="actions">
            ${p.file_stored ? `<button class="icon-btn" data-act="preview" data-id="${p.id}" title="${t("actions.preview")}">3D</button>` : ""}
            ${p.web_url ? `<a class="icon-btn" href="${esc(p.web_url)}" target="_blank" rel="noopener" title="${t("actions.webLink")}">🔗</a>` : ""}
            ${p.file_path ? `<button class="icon-btn" data-act="explorer" data-id="${p.id}" title="${t("actions.explorer")}">📁</button>` : ""}
            <button class="icon-btn" data-act="edit" data-id="${p.id}" title="${t("actions.edit")}">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${p.id}" title="${t("actions.delete")}">✕</button>
            ${unprintButton(p)}
            ${sliceButton(p)}
            ${partSlicerButton(p)}
            ${partDownloadButton(p)}
          </div></td>
        </tr>`).join("")}`).join("")}
      </tbody>
    </table>
    ${list.length ? "" : `<div class="empty">${t("parts.empty")}</div>`}`;
  $("#parts-filter").addEventListener("change", (e) => { partsFilter = e.target.value; renderParts(); });
  $("#btn-add-part-global").addEventListener("click", () => openPartModal(null));
  view.querySelectorAll("th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (partsSortKey === k) partsSortDir *= -1;
      else { partsSortKey = k; partsSortDir = 1; }
      renderParts();
    }));
  view.querySelectorAll(".proj-link").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); openProject(+a.dataset.project); }));
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => partAction(btn.dataset.act, +btn.dataset.id)));
  attachInlineEditing(view);
}

// ---------------------------------------------------------------- project view

function openProject(id) {
  if (currentProjectId !== id) selectedProjectPartIds.clear();
  currentProjectId = id;
  showView("project");
}

let selectedProjectPartIds = new Set();

async function renderProject() {
  const [project, parts, spools] = await Promise.all([
    api(`/api/projects/${currentProjectId}`), api(`/api/parts?project_id=${currentProjectId}`), api("/api/spools"),
  ]);
  spoolsCache = spools;
  const view = $("#view-project");
  view.innerHTML = `
    <button class="btn back-btn" id="btn-back">${t("project.back")}</button>
    <div class="toolbar">
      <h2 style="margin:0">${esc(project.name)}</h2>
      <span class="muted">${esc(project.description)}</span>
      ${project.url ? `<a class="btn" href="${esc(project.url)}" target="_blank" rel="noopener">${t("project.openLink")}</a>` : ""}
      <div class="spacer"></div>
      <button class="btn" id="btn-edit-project">${t("project.edit")}</button>
      <a class="btn" href="/api/export/project/${project.id}">${t("project.export")}</a>
      <button class="btn danger" id="btn-del-project">${t("project.delete")}</button>
      <button class="btn primary" id="btn-add-part">${t("project.addPart")}</button>
    </div>
    ${project.notes ? `<div class="project-notes">📝 ${esc(project.notes)}</div>` : ""}
    <div class="toolbar">
      <label class="muted" style="display:flex;align-items:center;gap:6px">${t("project.runs")}
        <input class="inline-input w-num" id="project-runs" type="number" min="1" step="1" value="${project.runs}">
      </label>
      <span class="muted">${t("parts.summary", {
        n: parts.filter((p) => p.copies_printed < p.copies * project.runs).length,
        time: fmtTime(parts.reduce((s, p) => s + p.time_min * (p.copies * project.runs - Math.min(p.copies_printed, p.copies * project.runs)), 0)),
        fil: fmtG(parts.reduce((s, p) => s + p.filament_g * (p.copies * project.runs - Math.min(p.copies_printed, p.copies * project.runs)), 0)),
      })}</span>
    </div>
    <div class="toolbar bulk-toolbar">
      <span id="bulk-selected-count" class="muted"></span>
      <div class="spacer"></div>
      <select id="bulk-status">
        <option value="">${t("bulk.chooseStatus")}</option>
        ${statusOptions("")}
      </select>
      <button class="btn primary" id="bulk-apply" disabled>${t("bulk.apply")}</button>
    </div>
    <table>
      <thead><tr>
        <th class="select-col"><input type="checkbox" id="project-select-all" aria-label="${t("bulk.selectAll")}"></th>
        <th>${t("table.name")}</th><th class="num">${t("table.copies")}</th><th class="num">${t("table.printed")}</th><th>${t("table.status")}</th>
        <th class="num">${t("part.timePerCopy")}</th><th class="num">${t("part.filamentPerCopy")}</th>
        <th>${t("table.spool")}</th><th class="num">${t("table.priority")}</th><th></th>
      </tr></thead>
      <tbody>
        ${parts.map((p) => `
        <tr>
          <td class="select-col"><input type="checkbox" class="project-part-select" data-id="${p.id}" ${selectedProjectPartIds.has(p.id) ? "checked" : ""} aria-label="${t("bulk.selectPart", { name: esc(p.name) })}"></td>
          <td>
            <input class="inline-input w-name" type="text" data-id="${p.id}" data-field="name" value="${esc(p.name)}">
            ${p.notes ? `<span class="muted" title="${esc(p.notes)}"> 📝</span>` : ""}
          </td>
          <td class="num"><input class="inline-input w-num" type="number" min="1" step="1" data-id="${p.id}" data-field="copies" value="${p.copies}" title="${t("table.totalCopies")}: ${p.copies * project.runs}"></td>
          <td class="num">${p.copies_printed} / ${p.copies * project.runs}</td>
          <td><select class="status-sel" data-id="${p.id}">${statusOptions(p.status)}</select></td>
          <td class="num"><input class="inline-input w-num" type="number" min="0" step="1" data-id="${p.id}" data-field="time_min" value="${p.time_min}" title="${t("table.time")}: ${fmtTime(p.time_min * p.copies * project.runs)}"></td>
          <td class="num"><input class="inline-input w-num" type="number" min="0" step="0.1" data-id="${p.id}" data-field="filament_g" value="${p.filament_g}" title="${t("table.filament")}: ${fmtG(p.filament_g * p.copies * project.runs)}"></td>
          <td><select class="status-sel" data-id="${p.id}" data-field="spool_id">${spoolOptions(p.spool_id)}</select></td>
          <td class="num"><input class="inline-input w-prio" type="number" step="1" data-id="${p.id}" data-field="priority" value="${p.priority}"></td>
          <td><div class="actions">
            ${p.file_stored ? `<button class="icon-btn" data-act="preview" data-id="${p.id}" title="${t("actions.preview")}">3D</button>` : ""}
            ${p.file_stored ? `<button class="icon-btn" data-act="download" data-id="${p.id}" title="${t("actions.downloadNamed", { name: esc(p.file_name), size: fmtBytes(p.file_size) })}">↓</button>` : ""}
            ${p.web_url ? `<a class="icon-btn" href="${esc(p.web_url)}" target="_blank" rel="noopener" title="${t("actions.webLink")}">🔗</a>` : ""}
            ${p.file_path ? `<button class="icon-btn" data-act="explorer" data-id="${p.id}" title="${t("actions.explorer")}">📁</button>` : ""}
            <button class="icon-btn" data-act="edit" data-id="${p.id}" title="${t("actions.edit")}">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${p.id}" title="${t("actions.delete")}">✕</button>
            ${unprintButton(p)}
            ${sliceButton(p)}
            ${partSlicerButton(p)}
          </div></td>
        </tr>`).join("")}
      </tbody>
    </table>
    ${parts.length ? "" : `<div class="empty">${t("project.empty")}</div>`}`;
  $("#btn-back").addEventListener("click", () => showView("dashboard"));
  $("#btn-add-part").addEventListener("click", () => openPartModal(null));
  $("#btn-edit-project").addEventListener("click", () => openProjectModal(project));
  $("#btn-del-project").addEventListener("click", async () => {
    if (!confirm(t("project.confirmDelete", { name: project.name }))) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    showView("dashboard");
  });
  $("#project-runs").addEventListener("change", async (e) => {
    const runs = Math.max(1, parseInt(e.target.value) || 1);
    await api(`/api/projects/${project.id}`, { method: "PUT", json: { runs } });
    render();
  });
  const selectAll = $("#project-select-all");
  const bulkStatus = $("#bulk-status");
  const bulkApply = $("#bulk-apply");
  const updateBulkSelection = () => {
    const selectedCount = parts.filter((p) => selectedProjectPartIds.has(p.id)).length;
    $("#bulk-selected-count").textContent = t("bulk.selected", { count: selectedCount });
    selectAll.checked = parts.length > 0 && selectedCount === parts.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < parts.length;
    bulkApply.disabled = selectedCount === 0 || !bulkStatus.value;
  };
  selectAll.addEventListener("change", () => {
    for (const part of parts) {
      if (selectAll.checked) selectedProjectPartIds.add(part.id);
      else selectedProjectPartIds.delete(part.id);
    }
    view.querySelectorAll(".project-part-select").forEach((cb) => { cb.checked = selectAll.checked; });
    updateBulkSelection();
  });
  view.querySelectorAll(".project-part-select").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = +cb.dataset.id;
      if (cb.checked) selectedProjectPartIds.add(id);
      else selectedProjectPartIds.delete(id);
      updateBulkSelection();
    }));
  bulkStatus.addEventListener("change", updateBulkSelection);
  bulkApply.addEventListener("click", async () => {
    const ids = parts.filter((p) => selectedProjectPartIds.has(p.id)).map((p) => p.id);
    if (!ids.length || !bulkStatus.value) return;
    bulkApply.disabled = true;
    try {
      for (const id of ids) {
        await api(`/api/parts/${id}`, { method: "PUT", json: { status: bulkStatus.value } });
      }
      selectedProjectPartIds.clear();
      toast(t("bulk.updated", { count: ids.length }));
      await renderProject();
    } catch {
      await renderProject();
    }
  });
  updateBulkSelection();
  attachInlineEditing(view);
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => partAction(btn.dataset.act, +btn.dataset.id)));
}

async function partAction(act, id) {
  const part = await api(`/api/parts/${id}`);
  if (!part) return;
  if (act === "preview") return openPreview(part);
  if (act === "download") {
    const a = document.createElement("a");
    a.href = `/api/parts/${id}/file`;
    a.download = part.file_name || t("common.stlFallback");
    a.click();
    return;
  }
  if (act === "explorer") { await api(`/api/parts/${id}/open-explorer`, { method: "POST" }); return; }
  if (act === "slicer") {
    await api(`/api/parts/${id}/open-slicer`, { method: "POST" });
    toast(t("actions.slicerStarted"));
    return;
  }
  if (act === "unprint") return openUnprintModal(part);
  if (act === "slice") return openSliceModal(part);
  if (act === "edit") return openPartModal(part);
  if (act === "delete") {
    if (!confirm(t("confirm.deletePart", { name: part.name }))) return;
    await api(`/api/parts/${id}`, { method: "DELETE" });
    render();
  }
}

// ---------------------------------------------------------------- queue

let queueSearch = "";

async function renderQueue() {
  const parts = await api("/api/parts?status=queue");
  const projects = await api("/api/projects");
  const pname = (id) => projects.find((p) => p.id === id)?.name || "?";
  const view = $("#view-queue");
  view.innerHTML = `
    <div class="toolbar"><h2 style="margin:0">${t("queue.title")}</h2>
      <span class="muted">${t("queue.hint")}</span>
      <div class="spacer"></div>
      <input class="inline-input queue-search" id="queue-search" type="search"
             placeholder="${t("queue.search")}" value="${esc(queueSearch)}">
    </div>
    <div id="queue-list">
    ${parts.map((p, i) => {
    const total = p.copies * (p.project_runs || 1);
    const remaining = total - p.copies_printed;
    return `
      <div class="queue-item" data-id="${p.id}" data-search="${esc((p.name + " " + pname(p.project_id)).toLowerCase())}">
        <div class="pos">${i + 1}</div>
        <div class="name"><button type="button" class="part-link" data-open-part="${p.id}" title="${t("actions.openPart")}">${esc(p.name)}</button>
          <div class="proj">${esc(pname(p.project_id))} · ${t("queue.progress", {
      printed: p.copies_printed, total, remaining,
    })} · ${fmtTime(p.time_min * remaining)} · ${fmtG(p.filament_g * remaining)}</div>
        </div>
        <div class="meta">${p.spool_color_hex ? `<span class="swatch" style="background:${esc(p.spool_color_hex)}"></span>` : ""}</div>
        ${unprintButton(p)}
        <div class="queue-print-control">
          <input class="queue-print-count" type="number" min="1" max="${remaining}" value="1" data-print-count="${p.id}" aria-label="${t("queue.printCount")}">
          <button class="btn small" data-print="${p.id}" title="${t("queue.recordPrint")}">${t("queue.recordPrint")}</button>
        </div>
        <div class="arrows">
          <button class="icon-btn" data-move="-1" ${i === 0 ? "disabled" : ""}>▲</button>
          <button class="icon-btn" data-move="1" ${i === parts.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        ${partSlicerButton(p)}
        ${partDownloadButton(p)}
      </div>`;
  }).join("") || `<div class="empty">${t("queue.empty")}</div>`}
    </div>
    <div class="empty" id="queue-no-match" hidden>${t("queue.noMatch")}</div>`;

  $("#queue-search").addEventListener("input", (e) => {
    queueSearch = e.target.value;
    applyQueueFilter();
  });
  applyQueueFilter();
  view.querySelectorAll(".queue-item").forEach((item) =>
    item.addEventListener("click", (e) => {
      const control = e.target.closest("button, a, input, select");
      if (control && !control.matches("[data-open-part]")) return;
      openPart(+item.dataset.id);
    }));
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => partAction(btn.dataset.act, +btn.dataset.id)));
  view.querySelectorAll("[data-move]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const dir = +btn.dataset.move;
      const ids = parts.map((p) => p.id);
      const idx = parts.findIndex((p) => p.id === +btn.closest(".queue-item").dataset.id);
      [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
      await api("/api/queue/reorder", { json: { ids } });
      render();
    }));
  view.querySelectorAll("[data-print]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = view.querySelector(`[data-print-count="${btn.dataset.print}"]`);
      const copies = Math.max(1, parseInt(input.value) || 1);
      await api(`/api/parts/${btn.dataset.print}/print`, { json: { copies } });
      render();
    }));
}

function applyQueueFilter() {
  const query = queueSearch.trim().toLowerCase();
  const items = document.querySelectorAll("#queue-list .queue-item");
  let visible = 0;
  items.forEach((item) => {
    const match = !query || (item.dataset.search || "").includes(query);
    item.hidden = !match;
    if (match) visible++;
  });
  const none = $("#queue-no-match");
  if (none) none.hidden = !(query && items.length && visible === 0);
}

// ---------------------------------------------------------------- spools

async function renderSpools() {
  const [spools, stats] = await Promise.all([api("/api/spools"), api("/api/stats")]);
  spoolsCache = spools;
  const plannedTotal = spools.reduce((sum, s) => sum + s.planned_g, 0) + stats.filament_unassigned_g;
  const missingTotal = spools.reduce((sum, s) => sum + s.missing_g, 0) + stats.filament_unassigned_g;
  const view = $("#view-spools");
  view.innerHTML = `
    <div class="toolbar"><h2 style="margin:0">${t("spools.title")}</h2>
      <span class="muted">${t("spools.summary", { planned: fmtG(plannedTotal), missing: fmtG(missingTotal) })}</span>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-new-spool">${t("spools.new")}</button></div>
    ${stats.filament_unassigned_g > 0 ? `<div class="unassigned-warning">${t("spools.unassigned", { amount: fmtG(stats.filament_unassigned_g) })}</div>` : ""}
    <table>
      <thead><tr><th>${t("spools.color")}</th><th>${t("spools.material")}</th><th>${t("spools.label")}</th>
        <th class="num">${t("spools.count")}</th><th class="num">${t("spools.stock")}</th>
        <th class="num">${t("spools.planned")}</th><th class="num">${t("spools.missing")}</th>
        <th>${t("spools.linked")}</th><th></th></tr></thead>
      <tbody>
        ${spools.map((s) => {
    const avail = s.available_g;
    const cap = (s.total_g || 0) * (s.count || 1);
    const planned = s.planned_g;
    const missing = s.missing_g;
    const pct = cap ? Math.round(100 * avail / cap) : 0;
    const low = pct < 15;
    return `
        <tr>
          <td><span class="swatch" style="background:${esc(s.color_hex)}"></span> ${esc(s.color)}</td>
          <td>${esc(s.material)}</td>
          <td class="muted">${esc(s.label)}</td>
          <td class="num">${s.count || 1}×</td>
          <td class="num">
            <div class="progress" style="width:120px"><div style="width:${pct}%; background:${low ? "var(--bad)" : "var(--ok)"}"></div></div>
            ${fmtG(avail)} / ${fmtG(cap)} ${low ? `<span class="badge low">${t("spools.low")}</span>` : ""}
          </td>
          <td class="num">${fmtG(planned)}</td>
          <td class="num">${missing > 0 ? `<span class="badge low">${fmtG(missing)}</span>` : fmtG(0)}</td>
          <td class="num">${s.parts_count}</td>
          <td><div class="actions">
            <button class="icon-btn" data-act="refill" data-id="${s.id}" title="${t("spools.refill")}">+</button>
            <button class="icon-btn" data-act="edit" data-id="${s.id}" title="${t("actions.edit")}">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${s.id}" title="${t("actions.delete")}">✕</button>
          </div></td>
        </tr>`;
  }).join("")}
      </tbody>
    </table>
    ${spools.length ? "" : `<div class="empty">${t("spools.empty")}</div>`}`;
  $("#btn-new-spool").addEventListener("click", () => openSpoolModal(null));
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const s = spoolsCache.find((x) => x.id === +btn.dataset.id);
      if (btn.dataset.act === "edit") openSpoolModal(s);
      else if (btn.dataset.act === "refill") {
        const amount = parseFloat(prompt(t("spools.refillPrompt", { material: s.material }), "1000"));
        if (amount > 0) { await api(`/api/spools/${s.id}/refill`, { json: { amount_g: amount } }); render(); }
      } else if (btn.dataset.act === "delete") {
        if (!confirm(t("spools.confirmDelete", { color: s.color, material: s.material }))) return;
        await api(`/api/spools/${s.id}`, { method: "DELETE" });
        render();
      }
    }));
}

// ---------------------------------------------------------------- modals

function fillProjectSelect(sel, selectedId) {
  sel.innerHTML = `<option value="">${t("common.chooseProject")}</option>` +
    projectsCache.map((p) => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

function spoolAvailable(s) {
  return (s.remaining_g || 0) + Math.max(0, (s.count || 1) - 1) * (s.total_g || 0);
}

function spoolOptions(selectedId) {
  return `<option value="">${t("spools.none")}</option>` +
    spoolsCache.map((s) =>
      `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(s.color)} · ${esc(s.material)} (${t("spools.available", { g: fmtG(spoolAvailable(s)) })})</option>`).join("");
}

function fillSpoolSelect(sel, selectedId) {
  sel.innerHTML = spoolOptions(selectedId);
}

function openProjectModal(project = null) {
  const form = $("#project-form");
  form.reset();
  $("#project-modal-title").textContent = t(project ? "projectModal.titleEdit" : "projectModal.titleNew");
  if (project) {
    form.name.value = project.name;
    form.description.value = project.description;
    form.notes.value = project.notes || "";
    form.url.value = project.url || "";
    form.runs.value = project.runs || 1;
  } else {
    form.runs.value = 1;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value, description: form.description.value,
      notes: form.notes.value, url: form.url.value,
      runs: Math.max(1, parseInt(form.runs.value) || 1),
    };
    if (project) await api(`/api/projects/${project.id}`, { method: "PUT", json: data });
    else await api("/api/projects", { json: data });
    $("#project-modal").close();
    currentView === "project" ? render() : showView("dashboard");
  };
  $("#project-modal").showModal();
}

let partViewer = null;

function disposePartViewer() {
  if (partViewer) { partViewer.dispose(); partViewer = null; }
  $("#part-preview").hidden = true;
  $("#part-file-info").textContent = "";
}

async function showPartPreview(fileOrBuffer) {
  const canvas = $("#part-canvas");
  try {
    disposePartViewer();
    const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    partViewer = createViewer(canvas, buffer);
    $("#part-preview").hidden = false;
  } catch {
    toast(t("upload.stlReadFail"), true);
  }
}

async function openPartModal(part = null, projectId = null) {
  const form = $("#part-form");
  form.reset();
  $("#part-modal-title").textContent = t(part ? "part.titleEdit" : "part.titleNew");
  const [projects, spools] = await Promise.all([api("/api/projects"), api("/api/spools")]);
  projectsCache = projects;
  spoolsCache = spools;
  fillSpoolSelect(form.spool_id, part?.spool_id);
  $("#part-project-label").hidden = !!part;
  form.project_id.innerHTML = `<option value="">${t("common.chooseProject")}</option>` +
    projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  if (part) {
    form.name.value = part.name;
    form.copies.value = part.copies;
    form.status.value = part.status;
    form.time_min.value = part.time_min;
    form.filament_g.value = part.filament_g;
    form.file_path.value = part.file_path;
    form.web_url.value = part.web_url;
    form.notes.value = part.notes;
    form.priority.value = part.priority;
  } else {
    form.priority.value = 0;
    form.project_id.value = projectId ?? currentProjectId ?? "";
  }
  form.file.value = "";
  disposePartViewer();
  if (part?.file_stored) {
    $("#part-file-info").textContent =
      t("part.fileExisting", { name: part.file_name, size: fmtBytes(part.file_size) });
    showPartPreview(await loadFileBuffer(part.id));
  }
  form.file.onchange = () => {
    const f = form.file.files[0];
    if (!f) return;
    $("#part-file-info").textContent = t("part.fileNew", { name: f.name, size: fmtBytes(f.size) });
    showPartPreview(f);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value, copies: +form.copies.value, status: form.status.value,
      time_min: +form.time_min.value || 0, filament_g: +form.filament_g.value || 0,
      file_path: form.file_path.value, web_url: form.web_url.value,
      notes: form.notes.value, priority: +form.priority.value || 0,
      spool_id: form.spool_id.value ? +form.spool_id.value : null,
    };
    const file = form.file.files[0];
    if (part) {
      await api(`/api/parts/${part.id}`, { method: "PUT", json: data });
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await api(`/api/parts/${part.id}/file`, { method: "POST", body: fd });
      }
    } else {
      data.project_id = +form.project_id.value || 0;
      if (!data.project_id) { toast(t("part.chooseProject"), true); return; }
      if (file) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(data)) fd.append(k, v);
        fd.append("file", file);
        await api("/api/parts", { method: "POST", body: fd });
      } else {
        await api("/api/parts", { json: data });
      }
    }
    $("#part-modal").close();
    disposePartViewer();
    render();
  };
  $("#part-modal").showModal();
}

$("#part-modal").addEventListener("close", disposePartViewer);

$("#unprint-modal").addEventListener("close", () => { unprintPartId = null; });
$("#slice-modal").addEventListener("close", () => { slicePartId = null; });

for (const [btn, dlg] of [
  ["#part-cancel", "#part-modal"],
  ["#spool-cancel", "#spool-modal"],
  ["#project-cancel", "#project-modal"],
  ["#settings-cancel", "#settings-modal"],
  ["#unprint-cancel", "#unprint-modal"],
  ["#slice-cancel", "#slice-modal"],
]) {
  $(btn).addEventListener("click", () => $(dlg).close());
}

$("#color-presets").addEventListener("click", (e) => {
  const chip = e.target.closest(".color-chip");
  if (!chip) return;
  const form = $("#spool-form");
  form.color_hex.value = chip.dataset.hex;
  form.color.value = chip.dataset.name;
});

const COLOR_PRESETS = [
  ["color.black", "#111111"],
  ["color.white", "#f2f2f2"],
  ["color.gray", "#7f8c8d"],
  ["color.red", "#e02b2b"],
  ["color.orange", "#ff8c1a"],
  ["color.yellow", "#f5c518"],
  ["color.green", "#2fa84f"],
  ["color.blue", "#2b6fe0"],
  ["color.purple", "#8e44ad"],
  ["color.brown", "#8b5a2b"],
  ["color.pink", "#e85fa9"],
  ["color.turquoise", "#1fb6b0"],
  ["color.silver", "#b8c0c8"],
  ["color.gold", "#c9a227"],
  ["color.natural", "#d8cfc0"],
];

function renderColorPresets() {
  $("#color-presets").innerHTML = COLOR_PRESETS.map(([key, hex]) => {
    const name = t(key);
    return `<button type="button" class="color-chip" data-hex="${hex}" data-name="${esc(name)}" ` +
      `style="background:${hex}" title="${esc(name)}"></button>`;
  }).join("");
}

function openSpoolModal(spool = null) {
  const form = $("#spool-form");
  form.reset();
  renderColorPresets();
  $("#spool-modal-title").textContent = t(spool ? "spoolModal.titleEdit" : "spoolModal.titleNew");
  const matSel = form.material;
  const matCustom = form.material_custom;
  const known = spool && [...matSel.options].some(
    (o) => o.value && o.value !== "__other" && o.value === spool.material);
  if (spool) {
    if (known) {
      matSel.value = spool.material;
      matCustom.hidden = true;
      matCustom.value = "";
    } else {
      matSel.value = "__other";
      matCustom.hidden = false;
      matCustom.value = spool.material;
    }
    form.color.value = spool.color;
    form.color_hex.value = spool.color_hex;
    form.label.value = spool.label;
    form.total_g.value = spool.total_g;
    form.remaining_g.value = spool.remaining_g;
    form.count.value = spool.count || 1;
  } else {
    matSel.value = "PLA";
    matCustom.hidden = true;
    matCustom.value = "";
    form.color.value = t("spoolModal.unknownColor");
  }
  matSel.onchange = () => {
    matCustom.hidden = matSel.value !== "__other";
    if (!matCustom.hidden) matCustom.focus();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const material = matSel.value === "__other"
      ? (matCustom.value.trim() || "PLA")
      : matSel.value;
    const data = {
      material, color: form.color.value, color_hex: form.color_hex.value,
      label: form.label.value, total_g: +form.total_g.value || 0, remaining_g: +form.remaining_g.value || 0,
      count: +form.count.value || 1,
    };
    if (spool) await api(`/api/spools/${spool.id}`, { method: "PUT", json: data });
    else await api("/api/spools", { json: data });
    $("#spool-modal").close();
    render();
  };
  $("#spool-modal").showModal();
}

async function openPreview(part) {
  $("#preview-title").textContent = part.name;
  $("#preview-info").textContent = t("preview.loading");
  $("#preview-download").onclick = () => {
    const a = document.createElement("a");
    a.href = `/api/parts/${part.id}/file`;
    a.download = part.file_name || t("common.stlFallback");
    a.click();
  };
  $("#preview-slicer").onclick = async () => {
    try {
      await api(`/api/parts/${part.id}/open-slicer`, { method: "POST" });
      toast(t("actions.slicerStarted"));
    } catch { /* Fehler bereits als Toast */ }
  };
  const dlg = $("#preview-modal");
  const canvas = $("#preview-canvas");
  try {
    const buffer = await loadFileBuffer(part.id);
    dlg.showModal();
    await new Promise((r) => requestAnimationFrame(r));
    const viewer = createViewer(canvas, buffer);
    const loc = getLang() === "de" ? "de-DE" : "en-US";
    $("#preview-info").textContent = t("preview.dims", {
      x: viewer.size.x.toFixed(1),
      y: viewer.size.y.toFixed(1),
      z: viewer.size.z.toFixed(1),
      tri: viewer.triangles.toLocaleString(loc),
      size: fmtBytes(part.file_size),
    });
    dlg.addEventListener("close", () => viewer.dispose(), { once: true });
  } catch (e) {
    toast(t("preview.failed", { msg: e.message }), true);
  }
  $("#preview-close").onclick = () => dlg.close();
}

// ---------------------------------------------------------------- upload

let uploadFile = null;

async function openUploadModal(file) {
  if (!/\.stl$/i.test(file.name)) {
    toast(t("upload.onlyStl"), true);
    return;
  }
  const [projects, spools] = await Promise.all([api("/api/projects"), api("/api/spools")]);
  projectsCache = projects;
  spoolsCache = spools;
  uploadFile = file;
  $("#upload-file-label").textContent = `${file.name} (${fmtBytes(file.size)})`;
  $("#upload-name").value = file.name.replace(/\.stl$/i, "");
  $("#upload-copies").value = 1;
  $("#upload-new-project-name").hidden = true;
  $("#upload-new-project-name").value = "";
  $("#upload-spool").innerHTML = spoolOptions("");
  fillProjectSelect($("#upload-project"), currentView === "project" ? currentProjectId : "");
  $("#upload-modal").showModal();
  renderUploadPreview();
}

async function renderUploadPreview() {
  const canvas = $("#upload-canvas");
  try {
    const buffer = await uploadFile.arrayBuffer();
    if (uploadViewer) uploadViewer.dispose();
    uploadViewer = createViewer(canvas, buffer);
  } catch {
    toast(t("upload.stlReadFail"), true);
  }
}
let uploadViewer = null;

$("#upload-new-project").addEventListener("click", () => {
  const inp = $("#upload-new-project-name");
  inp.hidden = !inp.hidden;
  if (!inp.hidden) inp.focus();
});

$("#upload-project").addEventListener("change", () => {
  $("#upload-new-project-name").hidden = true;
  $("#upload-new-project-name").value = "";
});

$("#upload-cancel").addEventListener("click", () => {
  $("#upload-modal").close();
});

$("#upload-modal").addEventListener("close", () => {
  if (uploadViewer) { uploadViewer.dispose(); uploadViewer = null; }
  uploadFile = null;
});

$("#upload-save").addEventListener("click", async () => {
  let projectId = +$("#upload-project").value || 0;
  const nameInput = $("#upload-new-project-name");
  const newName = nameInput.hidden ? "" : nameInput.value.trim();
  if (newName) {
    const existing = projectsCache.find((p) => p.name.toLowerCase() === newName.toLowerCase());
    if (existing) {
      projectId = existing.id;
      toast(t("upload.projectExistsUsed", { name: existing.name }));
    } else {
      const p = await api("/api/projects", { json: { name: newName } });
      projectId = p.id;
    }
  }
  if (!projectId) { toast(t("upload.chooseProject"), true); return; }
  const fd = new FormData();
  fd.append("project_id", projectId);
  fd.append("name", $("#upload-name").value.trim() || uploadFile.name);
  fd.append("copies", $("#upload-copies").value || 1);
  const spoolId = $("#upload-spool").value;
  if (spoolId) fd.append("spool_id", spoolId);
  fd.append("file", uploadFile);
  await api("/api/parts", { method: "POST", body: fd });
  $("#upload-modal").close();
  if (uploadViewer) { uploadViewer.dispose(); uploadViewer = null; }
  toast(t("upload.saved"));
  if (currentView === "project" && +$("#upload-project").value !== currentProjectId) showView("dashboard");
  else render();
});

// global drag & drop
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  const file = [...(e.dataTransfer.files || [])][0];
  if (file) openUploadModal(file);
});

// ---------------------------------------------------------------- init

const VIEWS = ["dashboard", "parts", "project", "queue", "spools", "archive"];

function bootFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = (params.get("view") || "").toLowerCase();
  const projectId = parseInt(params.get("project"), 10);
  if (VIEWS.includes(view)) {
    if (view === "project" && projectId > 0) {
      currentProjectId = projectId;
      showView("project");
    } else {
      currentProjectId = null;
      showView(view);
    }
    return;
  }
  showView("dashboard");
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { currentProjectId = null; showView(b.dataset.tab); }));

applyI18n();
const params = new URLSearchParams(window.location.search);
const langParam = (params.get("lang") || "").toLowerCase();
if (langParam === "de" || langParam === "en") {
  setLang(langParam);
  applyI18n();
}
const langSelect = $("#lang-select");
langSelect.value = getLang();
langSelect.addEventListener("change", () => {
  setLang(langSelect.value);
  applyI18n();
  render();
});

bootFromUrl();
