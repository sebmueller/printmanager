import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}

async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    toast(`Fehler: ${msg}`, true);
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

const STATUS_LABEL = { geplant: "Geplant", queue: "In Queue", gedruckt: "Gedruckt", montiert: "Montiert" };

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
  if (!res.ok) throw new Error("Datei nicht gefunden");
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- state

let currentView = "dashboard";
let currentProjectId = null;
let projectsCache = [];
let spoolsCache = [];

function showView(name) {
  currentView = name;
  for (const v of ["dashboard", "parts", "project", "queue", "spools"]) {
    $(`#view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name || (name === "project" && b.dataset.tab === "dashboard")));
  render();
}

async function render() {
  if (currentView === "dashboard") await renderDashboard();
  else if (currentView === "parts") await renderParts();
  else if (currentView === "project") await renderProject();
  else if (currentView === "queue") await renderQueue();
  else if (currentView === "spools") await renderSpools();
}

// ---------------------------------------------------------------- dashboard

async function renderDashboard() {
  const [stats, projects] = await Promise.all([api("/api/stats"), api("/api/projects")]);
  projectsCache = projects;
  const view = $("#view-dashboard");
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">Projekte</h2>
      <div class="spacer"></div>
      <button class="btn" id="btn-import">⬆ Import</button>
      <a class="btn" id="btn-backup" href="/api/export/full">⬇ Backup (alles)</a>
      <button class="btn primary" id="btn-new-project">+ Neues Projekt</button>
      <p class="muted" style="margin:0">Tipp: STL-Datei einfach aufs Fenster ziehen</p>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="v">${stats.projects}</div><div class="l">Projekte</div></div>
      <div class="stat"><div class="v">${stats.copies_done}/${stats.copies}</div><div class="l">Kopien fertig</div></div>
      <div class="stat"><div class="v">${fmtTime(stats.time_open_min)}</div><div class="l">Restdruckzeit</div></div>
      <div class="stat"><div class="v">${fmtG(stats.filament_open_g)}</div><div class="l">Filament geplant</div></div>
      <div class="stat"><div class="v">${fmtG(stats.spool_remaining_g)}</div><div class="l">Spulen-Bestand</div></div>
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
            <span>${p.copies_done}/${p.copies_total} Kopien (${pct}%)</span>
            <span>${p.parts_count} Teile</span>
          </div>
          <div class="meta">
            <span>⏱ ${fmtTime(p.time_open)}</span>
            <span>🧵 ${fmtG(p.filament_open)}</span>
          </div>
        </div>`;
  }).join("") || '<div class="empty">Noch keine Projekte – zieh eine STL hierher oder lege ein Projekt an.</div>'}
    </div>`;
  view.querySelectorAll(".card").forEach((c) =>
    c.addEventListener("click", () => openProject(+c.dataset.project)));
  $("#btn-new-project").addEventListener("click", () => openProjectModal());
  $("#btn-import").addEventListener("click", () => $("#import-modal").showModal());
}

// ---------------------------------------------------------------- import

$("#import-cancel").addEventListener("click", () => $("#import-modal").close());

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const file = form.file.files[0];
  if (!file) return;
  const mode = form.mode.value;
  if (mode === "restore" &&
      !confirm("ACHTUNG: Es werden ALLE aktuellen Projekte, Teile und Spulen gelöscht und durch die Datei ersetzt. Fortfahren?")) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);
  try {
    const res = await api("/api/import", { method: "POST", body: fd });
    $("#import-modal").close();
    form.reset();
    toast(`Import OK: ${res.projects} Projekte, ${res.parts} Teile, ${res.spools} Spulen`);
    showView("dashboard");
  } catch { /* Fehler schon als Toast gezeigt */ }
});

// ---------------------------------------------------------------- parts (global)

let partsSortKey = "status";
let partsSortDir = 1;
let partsFilter = "alle";
const STATUS_RANK = { geplant: 0, queue: 1, gedruckt: 2, montiert: 3 };

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
      case "project": return (p.project_name || "").toLowerCase();
      case "copies": return p.copies;
      case "time": return p.time_min * p.copies;
      case "filament": return p.filament_g * p.copies;
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

  const open = list.filter((p) => STATUS_RANK[p.status] <= 1);
  const sumTime = open.reduce((s, p) => s + p.time_min * p.copies, 0);
  const sumFil = open.reduce((s, p) => s + p.filament_g * p.copies, 0);
  const arrow = (k) => partsSortKey === k ? (partsSortDir === 1 ? " ▲" : " ▼") : "";

  const view = $("#view-parts");
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">Teile <span class="muted">(${list.length})</span></h2>
      <span class="muted">Offen: ${open.length} Teile · ⏱ ${fmtTime(sumTime)} · 🧵 ${fmtG(sumFil)}</span>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-add-part-global">+ Teil</button>
      <label class="muted" style="display:flex;align-items:center;gap:6px">Filter
        <select class="status-sel" id="parts-filter">
          <option value="alle" ${partsFilter === "alle" ? "selected" : ""}>Alle</option>
          <option value="offen" ${partsFilter === "offen" ? "selected" : ""}>Nur offene</option>
          <option value="geplant" ${partsFilter === "geplant" ? "selected" : ""}>Geplant</option>
          <option value="queue" ${partsFilter === "queue" ? "selected" : ""}>In Queue</option>
          <option value="gedruckt" ${partsFilter === "gedruckt" ? "selected" : ""}>Gedruckt</option>
          <option value="montiert" ${partsFilter === "montiert" ? "selected" : ""}>Montiert</option>
        </select>
      </label>
    </div>
    <table>
      <thead><tr>
        <th class="sortable" data-sort="name">Name${arrow("name")}</th>
        <th class="sortable" data-sort="project">Projekt${arrow("project")}</th>
        <th class="sortable num" data-sort="copies">Kopien${arrow("copies")}</th>
        <th class="sortable" data-sort="status">Status${arrow("status")}</th>
        <th class="sortable num" data-sort="time">Zeit${arrow("time")}</th>
        <th class="sortable num" data-sort="filament">Filament${arrow("filament")}</th>
        <th class="sortable" data-sort="color">Farbe${arrow("color")}</th>
        <th class="sortable num" data-sort="priority">Prio${arrow("priority")}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${list.map((p) => `
        <tr>
          <td>
            ${p.file_stored ? `<button class="icon-btn" data-act="preview" data-id="${p.id}" title="3D-Vorschau">🧊</button>` : ""}
            <strong>${esc(p.name)}</strong>
            ${p.file_stored ? `<button class="icon-btn" data-act="download" data-id="${p.id}" title="Datei herunterladen (${esc(p.file_name)}, ${fmtBytes(p.file_size)})">⬇</button>` : ""}
            ${p.web_url ? `<a class="icon-btn" href="${esc(p.web_url)}" target="_blank" rel="noopener" title="Web-Link öffnen">🔗</a>` : ""}
            ${p.notes ? `<span class="muted" title="${esc(p.notes)}"> 📝</span>` : ""}
          </td>
          <td><a href="#" class="proj-link" data-project="${p.project_id}">${esc(p.project_name || "?")}</a></td>
          <td class="num">${p.copies}</td>
          <td>
            <select class="status-sel" data-id="${p.id}">
              ${Object.entries(STATUS_LABEL).map(([k, v]) =>
    `<option value="${k}" ${p.status === k ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </td>
          <td class="num">${fmtTime(p.time_min * p.copies)}</td>
          <td class="num">${fmtG(p.filament_g * p.copies)}</td>
          <td>${p.spool_color_hex ? `<span class="swatch" style="background:${esc(p.spool_color_hex)}"></span> ${esc(p.spool_color)}` : "—"}</td>
          <td class="num">${p.priority}</td>
          <td><div class="actions">
            ${p.file_path ? `<button class="icon-btn" data-act="explorer" data-id="${p.id}" title="Im Explorer zeigen">📁</button>` : ""}
            <button class="icon-btn" data-act="edit" data-id="${p.id}" title="Bearbeiten">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${p.id}" title="Löschen">🗑</button>
          </div></td>
        </tr>`).join("")}
      </tbody>
    </table>
    ${list.length ? "" : '<div class="empty">Keine Teile für diesen Filter.</div>'}`;
  $("#parts-filter").addEventListener("change", (e) => { partsFilter = e.target.value; renderParts(); });
  $("#btn-add-part-global").addEventListener("click", () => openPartModal(null));
  view.querySelectorAll("th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (partsSortKey === k) partsSortDir *= -1;
      else { partsSortKey = k; partsSortDir = 1; }
      renderParts();
    }));
  view.querySelectorAll(".status-sel[data-id]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      await api(`/api/parts/${sel.dataset.id}`, { method: "PUT", json: { status: sel.value } });
      render();
    }));
  view.querySelectorAll(".proj-link").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); openProject(+a.dataset.project); }));
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => partAction(btn.dataset.act, +btn.dataset.id)));
}

// ---------------------------------------------------------------- project view

function openProject(id) {
  currentProjectId = id;
  showView("project");
}

async function renderProject() {
  const [project, parts, spools] = await Promise.all([
    api(`/api/projects/${currentProjectId}`), api(`/api/parts?project_id=${currentProjectId}`), api("/api/spools"),
  ]);
  spoolsCache = spools;
  const view = $("#view-project");
  view.innerHTML = `
    <button class="btn back-btn" id="btn-back">← Zurück</button>
    <div class="toolbar">
      <h2 style="margin:0">${esc(project.name)}</h2>
      <span class="muted">${esc(project.description)}</span>
      <div class="spacer"></div>
      <button class="btn" id="btn-edit-project">✏️ Bearbeiten</button>
      <a class="btn" href="/api/export/project/${project.id}">⬇ Export</a>
      <button class="btn danger" id="btn-del-project">🗑 Projekt löschen</button>
      <button class="btn primary" id="btn-add-part">+ Teil</button>
    </div>
    <table>
      <thead><tr>
        <th>Name</th><th class="num">Kopien</th><th>Status</th>
        <th class="num">Zeit</th><th class="num">Filament</th><th>Spule</th><th>Prio</th><th></th>
      </tr></thead>
      <tbody>
        ${parts.map((p) => `
        <tr>
          <td>
            ${p.file_stored ? `<button class="icon-btn" data-act="preview" data-id="${p.id}" title="3D-Vorschau">🧊</button>` : ""}
            <strong>${esc(p.name)}</strong>
            ${p.file_stored ? `<button class="icon-btn" data-act="download" data-id="${p.id}" title="Datei herunterladen (${esc(p.file_name)}, ${fmtBytes(p.file_size)})">⬇</button>` : ""}
            ${p.web_url ? `<a class="icon-btn" href="${esc(p.web_url)}" target="_blank" rel="noopener" title="Web-Link öffnen">🔗</a>` : ""}
            ${p.notes ? `<span class="muted" title="${esc(p.notes)}"> 📝</span>` : ""}
          </td>
          <td class="num">${p.copies}</td>
          <td>
            <select class="status-sel" data-id="${p.id}">
              ${Object.entries(STATUS_LABEL).map(([k, v]) =>
    `<option value="${k}" ${p.status === k ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </td>
          <td class="num">${fmtTime(p.time_min * p.copies)}</td>
          <td class="num">${fmtG(p.filament_g * p.copies)}</td>
          <td>${p.spool_color_hex ? `<span class="swatch" style="background:${esc(p.spool_color_hex)}"></span> ${esc(p.spool_material)}` : "—"}</td>
          <td class="num">${p.priority}</td>
          <td><div class="actions">
            ${p.file_path ? `<button class="icon-btn" data-act="explorer" data-id="${p.id}" title="Im Explorer zeigen">📁</button>` : ""}
            <button class="icon-btn" data-act="edit" data-id="${p.id}" title="Bearbeiten">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${p.id}" title="Löschen">🗑</button>
          </div></td>
        </tr>`).join("")}
      </tbody>
    </table>
    ${parts.length ? "" : '<div class="empty">Noch keine Teile – zieh eine STL hierher oder lege ein Teil an.</div>'}`;
  $("#btn-back").addEventListener("click", () => showView("dashboard"));
  $("#btn-add-part").addEventListener("click", () => openPartModal(null));
  $("#btn-edit-project").addEventListener("click", () => openProjectModal(project));
  $("#btn-del-project").addEventListener("click", async () => {
    if (!confirm(`Projekt "${project.name}" inkl. aller Teile löschen?`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    showView("dashboard");
  });
  view.querySelectorAll(".status-sel").forEach((sel) =>
    sel.addEventListener("change", async () => {
      await api(`/api/parts/${sel.dataset.id}`, { method: "PUT", json: { status: sel.value } });
      render();
    }));
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
    a.download = part.file_name || "teil.stl";
    a.click();
    return;
  }
  if (act === "explorer") { await api(`/api/parts/${id}/open-explorer`, { method: "POST" }); return; }
  if (act === "edit") return openPartModal(part);
  if (act === "delete") {
    if (!confirm(`Teil "${part.name}" löschen?`)) return;
    await api(`/api/parts/${id}`, { method: "DELETE" });
    render();
  }
}

// ---------------------------------------------------------------- queue

async function renderQueue() {
  const parts = await api("/api/parts?status=queue");
  const projects = await api("/api/projects");
  const pname = (id) => projects.find((p) => p.id === id)?.name || "?";
  const view = $("#view-queue");
  view.innerHTML = `
    <div class="toolbar"><h2 style="margin:0">Warteschlange</h2>
      <span class="muted">Reihenfolge mit Pfeilen ändern</span></div>
    ${parts.map((p, i) => `
      <div class="queue-item" data-id="${p.id}">
        <div class="pos">${i + 1}</div>
        <div class="name"><strong>${esc(p.name)}</strong>
          <div class="proj">${esc(pname(p.project_id))} · ${p.copies}× · ${fmtTime(p.time_min * p.copies)} · ${fmtG(p.filament_g * p.copies)}</div>
        </div>
        <div class="meta">${p.spool_color_hex ? `<span class="swatch" style="background:${esc(p.spool_color_hex)}"></span>` : ""}</div>
        <div class="arrows">
          <button class="icon-btn" data-move="-1" ${i === 0 ? "disabled" : ""}>▲</button>
          <button class="icon-btn" data-move="1" ${i === parts.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <button class="btn small" data-print="${p.id}" title="Als gedruckt markieren">✔ Gedruckt</button>
      </div>`).join("") || '<div class="empty">Warteschlange ist leer – Teile auf "In Queue" setzen.</div>'}`;
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
      await api(`/api/parts/${btn.dataset.print}`, { method: "PUT", json: { status: "gedruckt" } });
      render();
    }));
}

// ---------------------------------------------------------------- spools

async function renderSpools() {
  const spools = await api("/api/spools");
  spoolsCache = spools;
  const view = $("#view-spools");
  view.innerHTML = `
    <div class="toolbar"><h2 style="margin:0">Filament-Spulen</h2><div class="spacer"></div>
      <button class="btn primary" id="btn-new-spool">+ Neue Spule</button></div>
    <table>
      <thead><tr><th>Farbe</th><th>Material</th><th>Etikett</th><th class="num">Anzahl</th><th class="num">Bestand</th><th>Verknüpfte Teile</th><th></th></tr></thead>
      <tbody>
        ${spools.map((s) => {
    const avail = (s.remaining_g || 0) * (s.count || 1);
    const cap = (s.total_g || 0) * (s.count || 1);
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
            ${fmtG(avail)} / ${fmtG(cap)} ${low ? '<span class="badge low">wenig</span>' : ""}
          </td>
          <td class="num">${s.parts_count}</td>
          <td><div class="actions">
            <button class="icon-btn" data-act="refill" data-id="${s.id}" title="Nachfüllen">➕</button>
            <button class="icon-btn" data-act="edit" data-id="${s.id}" title="Bearbeiten">✏️</button>
            <button class="icon-btn" data-act="delete" data-id="${s.id}" title="Löschen">🗑</button>
          </div></td>
        </tr>`;
  }).join("")}
      </tbody>
    </table>
    ${spools.length ? "" : '<div class="empty">Noch keine Spulen erfasst.</div>'}`;
  $("#btn-new-spool").addEventListener("click", () => openSpoolModal(null));
  view.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const s = spoolsCache.find((x) => x.id === +btn.dataset.id);
      if (btn.dataset.act === "edit") openSpoolModal(s);
      else if (btn.dataset.act === "refill") {
        const amount = parseFloat(prompt(`Wie viele Gramm ${esc(s.material)} nachfüllen?`, "1000"));
        if (amount > 0) { await api(`/api/spools/${s.id}/refill`, { json: { amount_g: amount } }); render(); }
      } else if (btn.dataset.act === "delete") {
        if (!confirm(`Spule "${s.color} ${s.material}" löschen?`)) return;
        await api(`/api/spools/${s.id}`, { method: "DELETE" });
        render();
      }
    }));
}

// ---------------------------------------------------------------- modals

function fillProjectSelect(sel, selectedId) {
  sel.innerHTML = '<option value="">— Projekt wählen —</option>' +
    projectsCache.map((p) => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

function fillSpoolSelect(sel, selectedId) {
  sel.innerHTML = '<option value="">— keine —</option>' +
    spoolsCache.map((s) =>
      `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(s.color)} · ${esc(s.material)} (${fmtG((s.remaining_g || 0) * (s.count || 1))} verfügbar)</option>`).join("");
}

function openProjectModal(project = null) {
  const form = $("#project-form");
  form.reset();
  $("#project-modal-title").textContent = project ? "Projekt bearbeiten" : "Neues Projekt";
  if (project) {
    form.name.value = project.name;
    form.description.value = project.description;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = { name: form.name.value, description: form.description.value };
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
    toast("Datei konnte nicht als STL gelesen werden", true);
  }
}

async function openPartModal(part = null, projectId = null) {
  const form = $("#part-form");
  form.reset();
  $("#part-modal-title").textContent = part ? "Teil bearbeiten" : "Neues Teil";
  const [projects, spools] = await Promise.all([api("/api/projects"), api("/api/spools")]);
  projectsCache = projects;
  spoolsCache = spools;
  fillSpoolSelect(form.spool_id, part?.spool_id);
  $("#part-project-label").hidden = !!part;
  form.project_id.innerHTML = '<option value="">— Projekt wählen —</option>' +
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
    $("#part-file-info").textContent = `vorhanden: ${part.file_name} (${fmtBytes(part.file_size)}) – neue Datei ersetzt sie`;
    showPartPreview(await loadFileBuffer(part.id));
  }
  form.file.onchange = () => {
    const f = form.file.files[0];
    if (!f) return;
    $("#part-file-info").textContent = `neu: ${f.name} (${fmtBytes(f.size)})`;
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
      if (!data.project_id) { toast("Bitte Projekt wählen", true); return; }
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

function openSpoolModal(spool = null) {
  const form = $("#spool-form");
  form.reset();
  $("#spool-modal-title").textContent = spool ? "Spule bearbeiten" : "Neue Spule";
  if (spool) {
    form.material.value = spool.material;
    form.color.value = spool.color;
    form.color_hex.value = spool.color_hex;
    form.label.value = spool.label;
    form.total_g.value = spool.total_g;
    form.remaining_g.value = spool.remaining_g;
    form.count.value = spool.count || 1;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      material: form.material.value, color: form.color.value, color_hex: form.color_hex.value,
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
  $("#preview-info").textContent = "Lade Vorschau…";
  $("#preview-download").onclick = () => {
    const a = document.createElement("a");
    a.href = `/api/parts/${part.id}/file`;
    a.download = part.file_name || "teil.stl";
    a.click();
  };
  const dlg = $("#preview-modal");
  const canvas = $("#preview-canvas");
  try {
    const buffer = await loadFileBuffer(part.id);
    dlg.showModal();
    await new Promise((r) => requestAnimationFrame(r));
    const viewer = createViewer(canvas, buffer);
    $("#preview-info").textContent =
      `Maße: ${viewer.size.x.toFixed(1)} × ${viewer.size.y.toFixed(1)} × ${viewer.size.z.toFixed(1)} mm · ` +
      `${viewer.triangles.toLocaleString("de-DE")} Dreiecke · ${fmtBytes(part.file_size)}`;
    dlg.addEventListener("close", () => viewer.dispose(), { once: true });
  } catch (e) {
    toast("Vorschau fehlgeschlagen: " + e.message, true);
  }
  $("#preview-close").onclick = () => dlg.close();
}

// ---------------------------------------------------------------- upload

let uploadFile = null;

async function openUploadModal(file) {
  if (!/\.stl$/i.test(file.name)) {
    toast("Nur .stl-Dateien werden unterstützt", true);
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
  fillProjectSelect($("#upload-project"), "");
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
    toast("Datei konnte nicht als STL gelesen werden", true);
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
  const newName = $("#upload-new-project-name").value.trim();
  if (newName) {
    const p = await api("/api/projects", { json: { name: newName } });
    projectId = p.id;
  }
  if (!projectId) { toast("Bitte Projekt wählen oder anlegen", true); return; }
  const fd = new FormData();
  fd.append("project_id", projectId);
  fd.append("name", $("#upload-name").value.trim() || uploadFile.name);
  fd.append("copies", $("#upload-copies").value || 1);
  fd.append("file", uploadFile);
  await api("/api/parts", { method: "POST", body: fd });
  $("#upload-modal").close();
  if (uploadViewer) { uploadViewer.dispose(); uploadViewer = null; }
  toast("Teil gespeichert");
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

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { currentProjectId = null; showView(b.dataset.tab); }));

showView("dashboard");
