// Lodestone UI — wired to the engine (window.API). Home + Instances + Discover are
// functional; the rest port next.

const ico = (id) => `<svg class="ico"><use href="#${id}"/></svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const el = () => document.getElementById("content");

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 4200);
}

function loaderLabel(l) { return l === "vanilla" ? "Vanilla" : l[0].toUpperCase() + l.slice(1); }
function subtitle(i) { return i.loader === "vanilla" ? i.mcVersion : `${loaderLabel(i.loader)} ${i.mcVersion}`; }
const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : "" + n);
const accentFor = (hex) => `linear-gradient(135deg, ${hex}, ${hex}aa)`;

function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; }

// ---------- HOME ----------
async function renderHome() {
  el().innerHTML = `<div class="placeholder">${ico("i-home")}<h2>Loading…</h2></div>`;
  const [info, instances] = await Promise.all([API.info(), API.instances()]);
  const recent = instances[0];

  el().innerHTML = `
    <section class="hero">
      <div>
        <div class="hero-greeting">${greeting()}, KingEstel.</div>
        <div class="hero-sub">${recent ? `Jump back into ${esc(recent.name)} — ${esc(subtitle(recent))}.` : "Create your first instance to start playing."}</div>
      </div>
      <div class="hero-spacer"></div>
      ${recent
        ? `<button class="play-btn" data-play="${recent.id}">${ico("i-play")} Play ${esc(recent.name)}</button>`
        : `<button class="play-btn" data-goto="instances">${ico("i-plus")} New Instance</button>`}
    </section>

    <div class="engine-chip">${ico("i-server")} Engine: <b>${esc(info.platform)}</b> · ${esc(info.engine)} ${info.electron ? "· Electron " + esc(info.electron) : ""}
      <span class="engine-path" title="${esc(info.dataDir)}">${esc(info.dataDir)}</span></div>

    <section class="section">
      <div class="section-head"><span class="section-title">RECENT INSTANCES</span>
        <span class="section-action" data-goto="instances">All</span></div>
      ${instances.length ? `<div class="scroll-row">${instances.slice(0, 8).map(instCard).join("")}</div>`
        : `<div class="empty-line">No instances yet — head to <a data-goto="instances">Instances</a>.</div>`}
    </section>`;
  bindCommon();
}

// ---------- INSTANCES ----------
let creating = false;
async function renderInstances() {
  el().innerHTML = `<div class="placeholder">${ico("i-stack")}<h2>Loading…</h2></div>`;
  const instances = await API.instances();
  el().innerHTML = `
    <div class="page-head">
      <h1 class="page-title">Instances</h1>
      <div class="head-actions">
        <button class="btn-soft" id="add-from-code">${ico("i-bolt")} Add from code</button>
        <button class="btn-soft" id="import-pack">${ico("i-download")} Import</button>
        <button class="btn-soft" id="new-inst">${ico("i-plus")} New Instance</button>
      </div>
    </div>
    <div id="new-panel"></div>
    <div class="grid">
      ${instances.map(instGridCard).join("") || `<div class="empty-line">No instances yet — create one.</div>`}
    </div>`;
  document.getElementById("import-pack").onclick = async () => {
    const btn = document.getElementById("import-pack");
    const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Importing…`;
    try {
      const inst = await API.importModpack();
      if (inst) {
        const manual = (inst.manualDownloads && inst.manualDownloads.length) || 0;
        toast(manual
          ? `Imported ${inst.name}. ${manual} mod${manual === 1 ? "" : "s"} must be added by hand (the author blocked API downloads).`
          : `Imported ${inst.name}.`);
        renderInstances();
      }
      else { btn.disabled = false; btn.innerHTML = original; }   // dialog canceled
    } catch (e) {
      toast("Couldn't import: " + e.message);
      btn.disabled = false; btn.innerHTML = original;
    }
  };
  document.getElementById("add-from-code").onclick = () => openAddFromCodeModal();
  document.getElementById("new-inst").onclick = () => { creating = !creating; toggleNewPanel(); };
  if (creating) toggleNewPanel();
  bindCommon();
  el().querySelectorAll("[data-del]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    await API.deleteInstance(b.dataset.del); toast("Instance deleted."); renderInstances();
  });
  // Click a card (but not its Play/Delete buttons) to open its detail + mods.
  el().querySelectorAll("[data-open]").forEach((n) => n.addEventListener("click", (e) => {
    if (e.target.closest("[data-play],[data-del]")) return;
    renderInstanceDetail(n.dataset.open);
  }));
}

// ---------- INSTANCE DETAIL (mods + worlds + settings) ----------
async function renderInstanceDetail(id) {
  el().innerHTML = `<div class="placeholder">${ico("i-stack")}<h2>Loading…</h2></div>`;
  const [instances, mods, versions, worlds, backups] = await Promise.all([
    API.instances(), API.content.list(id), API.versions(), API.worlds.list(id), API.worlds.backups(id),
  ]);
  const inst = instances.find((i) => i.id === id);
  if (!inst) { navigate("instances"); return; }
  const modCount = mods.filter((m) => m.kind === "mod").length;

  // Version <select>: releases from the engine, with the instance's current version
  // guaranteed present (even if it's a snapshot Mojang no longer lists as a release).
  const releases = ((versions && versions.releases) || []).slice(0, 80);
  const versionOpts = (releases.includes(inst.mcVersion) ? releases : [inst.mcVersion, ...releases])
    .map((r) => `<option${r === inst.mcVersion ? " selected" : ""}>${esc(r)}</option>`).join("");

  el().innerHTML = `
    <div class="page-head"><button class="btn-ghost" data-goto="instances">${ico("i-arrow-right")} Instances</button></div>
    <div class="detail-hero glass">
      <div class="inst-art lg" style="background:${accentFor(inst.accent)}33">${ico("i-stack")}</div>
      <div class="detail-meta">
        <div class="detail-name">${esc(inst.name)}</div>
        <div class="detail-sub">${esc(subtitle(inst))} · ${modCount} mod${modCount === 1 ? "" : "s"}</div>
        <div class="detail-actions">
          <button class="btn-accent" data-play="${inst.id}">${ico("i-play")} Play</button>
          <button class="btn-soft" id="detail-add">${ico("i-plus")} Browse mods</button>
          <button class="btn-soft" id="detail-share">${ico("i-bolt")} Share &amp; Sync</button>
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">CONTENT</span></div>
    <div class="mods-list">
      ${mods.length ? mods.map(modRow).join("") : `<div class="empty-line">No mods yet. Hit "Browse mods" to add some from Modrinth.</div>`}
    </div>

    <div class="section-head" style="margin-top:26px"><span class="section-title">WORLDS</span></div>
    <div class="worlds-list">
      ${worlds.length ? worlds.map(worldRow).join("") : `<div class="empty-line">No worlds yet. Play the instance to create one.</div>`}
    </div>
    ${backups.length ? `
    <div class="section-head" style="margin-top:26px"><span class="section-title">BACKUPS</span></div>
    <div class="worlds-list">
      ${backups.map(backupRow).join("")}
    </div>` : ""}

    <div class="section-head" style="margin-top:26px"><span class="section-title">SETTINGS</span></div>
    <div class="glass edit-panel">
      <div class="np-grid edit-grid">
        <label>NAME<input id="ed-name" value="${esc(inst.name)}" /></label>
        <label>MINECRAFT VERSION<select id="ed-version">${versionOpts}</select></label>
        <label>RAM (MB)<input id="ed-ram" type="number" min="512" step="256" placeholder="Default" value="${inst.ramMB != null ? inst.ramMB : ""}" /></label>
      </div>
      <label class="edit-full">JAVA ARGUMENTS
        <input id="ed-java" placeholder="e.g. -XX:+UseG1GC -XX:MaxGCPauseMillis=50" value="${esc(inst.javaArgs || "")}" />
      </label>
      <div class="np-actions">
        <button class="btn-accent ed-save" style="width:auto;padding:9px 18px">Save changes</button>
      </div>
    </div>`;

  bindCommon();
  document.getElementById("detail-add").onclick = () => openDiscoverFor(inst.id);
  document.getElementById("detail-share").onclick = () => openShareModal(inst);
  el().querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    await API.content.remove({ instanceId: id, projectId: b.dataset.remove });
    toast("Removed."); renderInstanceDetail(id);
  });

  // Save instance settings.
  el().querySelector(".ed-save").onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const ram = el().querySelector("#ed-ram").value.trim();
    try {
      const updated = await API.updateInstance({
        id,
        name: el().querySelector("#ed-name").value,
        mcVersion: el().querySelector("#ed-version").value,
        ramMB: ram === "" ? null : Number(ram),
        javaArgs: el().querySelector("#ed-java").value,
      });
      toast(`Saved ${updated.name}.`); renderInstanceDetail(id);
    } catch (err) { btn.disabled = false; toast("Couldn't save: " + err.message); }
  };

  // Worlds: backup / rename / delete.
  el().querySelectorAll("[data-wbackup]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await API.worlds.backup({ instanceId: id, world: b.dataset.wbackup }); toast(`Backed up ${b.dataset.wbackup}.`); renderInstanceDetail(id); }
    catch (err) { b.disabled = false; toast("Backup failed: " + err.message); }
  });
  el().querySelectorAll("[data-wrename]").forEach((b) => b.onclick = async () => {
    const current = b.dataset.wrename;
    const name = prompt(`Rename world "${current}" to:`, current);
    if (name == null || !name.trim() || name.trim() === current) return;
    try { await API.worlds.rename({ instanceId: id, world: current, name: name.trim() }); toast("World renamed."); renderInstanceDetail(id); }
    catch (err) { toast("Rename failed: " + err.message); }
  });
  el().querySelectorAll("[data-wdelete]").forEach((b) => b.onclick = async () => {
    const world = b.dataset.wdelete;
    if (!confirm(`Delete "${world}" permanently? This cannot be undone.`)) return;
    try { await API.worlds.remove({ instanceId: id, world }); toast("World deleted."); renderInstanceDetail(id); }
    catch (err) { toast("Delete failed: " + err.message); }
  });
  // Backups: restore.
  el().querySelectorAll("[data-wrestore]").forEach((b) => b.onclick = async () => {
    const backup = b.dataset.wrestore;
    if (!confirm(`Restore "${backup}"? Any current files in that world folder will be overwritten.`)) return;
    b.disabled = true;
    try { await API.worlds.restore({ instanceId: id, backup }); toast("Backup restored."); renderInstanceDetail(id); }
    catch (err) { b.disabled = false; toast("Restore failed: " + err.message); }
  });
}

// ---------- SHARE & SYNC ----------
// Copy text to the clipboard, with a select-and-execCommand fallback for odd environments.
async function copyText(text, sourceEl) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      if (sourceEl) { sourceEl.focus(); sourceEl.select(); }
      return document.execCommand("copy");
    } catch { return false; }
  }
}

// Share modal for an instance: shows the pasteable share code (+ Copy), an "Export .mrpack
// file" button, and a "Sync from a code" box that reconciles this instance's mods to a code.
async function openShareModal(inst) {
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-bolt")} Share &amp; Sync</div>
      <p class="share-sub">A code or <b>.mrpack</b> file shares <b>${esc(inst.name)}</b>'s mod list so a friend can rebuild the same pack. Live auto-sync across machines is coming with accounts.</p>
      <div class="share-loading"><span class="spinner"></span> Building share code…</div>
    </div>`);
  let code = "";
  try { code = await API.share.code(inst.id); }
  catch (e) { toast("Couldn't build a share code: " + e.message); hideModal(); return; }

  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-bolt")} Share &amp; Sync</div>
      <p class="share-sub">A code or <b>.mrpack</b> file shares <b>${esc(inst.name)}</b>'s mod list so a friend can rebuild the same pack. Live auto-sync across machines is coming with accounts.</p>

      <div class="share-label">SHARE CODE</div>
      <textarea id="share-code" class="share-box" readonly rows="3">${esc(code)}</textarea>
      <div class="share-row">
        <button class="btn-accent share-btn" id="share-copy">${ico("i-download")} Copy code</button>
        <button class="btn-soft" id="share-mrpack">${ico("i-download")} Export .mrpack file</button>
      </div>

      <div class="share-divider"></div>

      <div class="share-label">SYNC FROM A CODE</div>
      <p class="share-note">Paste a code to make this instance match it: missing mods are installed, changed ones updated, and mods it doesn't include are removed.</p>
      <textarea id="sync-code" class="share-box" rows="3" placeholder="Paste a Lodestone share code…"></textarea>
      <div class="np-actions">
        <button class="btn-ghost" id="share-close">Close</button>
        <button class="btn-accent share-btn" id="sync-now">${ico("i-bolt")} Sync now</button>
      </div>
    </div>`);

  document.getElementById("share-close").onclick = hideModal;

  document.getElementById("share-copy").onclick = async () => {
    const ok = await copyText(code, document.getElementById("share-code"));
    toast(ok ? "Share code copied to the clipboard." : "Couldn't copy — select the code and copy it by hand.");
  };

  document.getElementById("share-mrpack").onclick = async (e) => {
    const btn = e.currentTarget; const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Exporting…`;
    try {
      const res = await API.share.mrpack(inst.id, inst.name);
      if (res) toast(`Exported ${res.files} mod${res.files === 1 ? "" : "s"} to ${res.path}${res.skipped ? ` (${res.skipped} skipped)` : ""}.`);
      btn.disabled = false; btn.innerHTML = original;
    } catch (err) {
      toast("Couldn't export: " + err.message);
      btn.disabled = false; btn.innerHTML = original;
    }
  };

  document.getElementById("sync-now").onclick = async (e) => {
    const value = document.getElementById("sync-code").value.trim();
    if (!value) { toast("Paste a share code to sync from."); return; }
    const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Syncing…`;
    try {
      const r = await API.share.syncFromCode({ id: inst.id, code: value });
      hideModal();
      const parts = [];
      if (r.added) parts.push(`${r.added} added`);
      if (r.removed) parts.push(`${r.removed} removed`);
      toast(parts.length ? `Synced ${inst.name}: ${parts.join(", ")}.` : `${inst.name} already matches that pack.`);
      renderInstanceDetail(inst.id);
    } catch (err) {
      btn.disabled = false; btn.innerHTML = `${ico("i-bolt")} Sync now`;
      toast("Couldn't sync: " + err.message);
    }
  };
}

// "Add from code" on the Instances page: paste a share code to spin up a new instance
// whose mods are synced to match the shared pack.
function openAddFromCodeModal() {
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-bolt")} Add from code</div>
      <p class="share-sub">Paste a Lodestone share code to create a new instance with the same mods. A code shares the pack; live auto-sync across machines is coming with accounts.</p>
      <textarea id="add-code" class="share-box" rows="3" placeholder="Paste a Lodestone share code…"></textarea>
      <div class="np-actions">
        <button class="btn-ghost" id="add-close">Cancel</button>
        <button class="btn-accent share-btn" id="add-create">${ico("i-plus")} Create instance</button>
      </div>
    </div>`);
  document.getElementById("add-close").onclick = hideModal;
  document.getElementById("add-create").onclick = async (e) => {
    const value = document.getElementById("add-code").value.trim();
    if (!value) { toast("Paste a share code first."); return; }
    const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Creating…`;
    try {
      const r = await API.share.createFromCode(value);
      hideModal();
      toast(`Created ${r.instance ? r.instance.name : "instance"}${r.added ? ` with ${r.added} mod${r.added === 1 ? "" : "s"}` : ""}.`);
      renderInstances();
    } catch (err) {
      btn.disabled = false; btn.innerHTML = `${ico("i-plus")} Create instance`;
      toast("Couldn't create from code: " + err.message);
    }
  };
}

// Turn an absolute filesystem path into a file:// URL the renderer can load (handles
// spaces and Windows drive paths).
function fileURL(p) {
  let s = String(p).replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s; // C:/… → /C:/… so it becomes file:///C:/…
  return "file://" + encodeURI(s);
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "unknown");
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : (n || 0) + " B");

const worldRow = (w) => `
  <div class="glass world-row">
    ${w.icon ? `<img class="hit-icon" src="${esc(fileURL(w.icon))}?v=${w.modified}" />` : `<div class="hit-icon ph">${ico("i-globe")}</div>`}
    <div class="hit-meta">
      <div class="hit-title">${esc(w.name)}</div>
      <div class="hit-desc">Updated ${esc(fmtDate(w.modified))}</div>
    </div>
    <div class="world-actions">
      <button class="btn-soft" data-wbackup="${esc(w.name)}">${ico("i-download")} Backup</button>
      <button class="btn-soft" data-wrename="${esc(w.name)}">Rename</button>
      <button class="btn-ghost world-x" data-wdelete="${esc(w.name)}" title="Delete permanently">${ico("i-trash")}</button>
    </div>
  </div>`;

const backupRow = (b) => `
  <div class="glass world-row">
    <div class="hit-icon ph">${ico("i-download")}</div>
    <div class="hit-meta">
      <div class="hit-title">${esc(b.world)}</div>
      <div class="hit-desc">${esc(fmtDate(b.created))} · ${esc(fmtSize(b.size))}</div>
    </div>
    <div class="world-actions">
      <button class="btn-soft" data-wrestore="${esc(b.name)}">Restore</button>
    </div>
  </div>`;

const modRow = (m) => `
  <div class="glass mod-row">
    ${m.iconURL ? `<img class="hit-icon" src="${esc(m.iconURL)}" />` : `<div class="hit-icon ph">${ico("i-grid")}</div>`}
    <div class="hit-meta">
      <div class="hit-title">${esc(m.title)} <span class="hit-author">${esc(m.versionNumber || "")}</span></div>
      <div class="hit-desc">${m.kind !== "mod" ? esc(m.kind) + " · " : ""}${m.requiredBy ? "dependency of " + esc(m.requiredBy) : esc(m.fileName)}</div>
    </div>
    <button class="btn-ghost mod-x" data-remove="${esc(m.projectId)}" title="Remove">${ico("i-trash")}</button>
  </div>`;

async function toggleNewPanel() {
  const panel = document.getElementById("new-panel");
  if (!creating) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="glass new-panel"><div class="np-row"><span>Loading versions…</span></div></div>`;
  const v = await API.versions();
  const loaders = ["vanilla", "fabric", "quilt", "neoforge", "forge"];
  panel.innerHTML = `
    <div class="glass new-panel">
      <div class="np-grid">
        <label>NAME<input id="np-name" placeholder="My Instance" /></label>
        <label>LOADER
          <div class="seg" id="np-loader">${loaders.map((l, i) => `<button data-l="${l}" class="${i === 0 ? "on" : ""}">${loaderLabel(l)}</button>`).join("")}</div>
        </label>
        <label>MINECRAFT VERSION
          <select id="np-version">${v.releases.slice(0, 60).map((r) => `<option>${r}</option>`).join("")}</select>
        </label>
      </div>
      <div class="np-actions">
        <button class="btn-ghost" id="np-cancel">Cancel</button>
        <button class="btn-accent np-create">${ico("i-plus")} Create</button>
      </div>
    </div>`;
  let loader = "vanilla";
  panel.querySelectorAll("#np-loader button").forEach((b) => b.onclick = () => {
    panel.querySelectorAll("#np-loader button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); loader = b.dataset.l;
  });
  panel.querySelector("#np-cancel").onclick = () => { creating = false; toggleNewPanel(); };
  panel.querySelector(".np-create").onclick = async () => {
    const name = panel.querySelector("#np-name").value;
    const mcVersion = panel.querySelector("#np-version").value;
    try {
      const inst = await API.createInstance({ name, mcVersion, loader });
      creating = false; toast(`Created ${inst.name}.`); renderInstances();
    } catch (e) { toast("Couldn't create: " + e.message); }
  };
}

const instGridCard = (i) => `
  <div class="glass inst-card wide" data-open="${i.id}">
    <div class="inst-art" style="background:${accentFor(i.accent)}33">${ico("i-stack")}
      <button class="card-del" data-del="${i.id}" title="Delete">${ico("i-trash")}</button>
    </div>
    <div class="inst-body">
      <div class="inst-name">${esc(i.name)}</div>
      <div class="inst-sub">${esc(subtitle(i))}${i.mods ? ` · ${i.mods} mod${i.mods === 1 ? "" : "s"}` : ""}</div>
      <button class="btn-accent" data-play="${i.id}" style="margin-top:10px">${ico("i-play")} Play</button>
    </div>
  </div>`;

const instCard = (i) => `
  <div class="glass inst-card" data-play="${i.id}">
    <div class="inst-art" style="background:${accentFor(i.accent)}33">${ico("i-stack")}</div>
    <div class="inst-body">
      <div class="inst-name">${esc(i.name)}</div>
      <div class="inst-sub">${esc(subtitle(i))}${i.mods ? ` · ${i.mods} mods` : ""}</div>
    </div>
  </div>`;

// ---------- DISCOVER ----------
let searchTimer = null;
let discoverTarget = null;   // instance id to add mods to, when Discover is opened from a detail page
let discoverSource = "modrinth";   // which catalog to browse: "modrinth" | "curseforge"
async function renderDiscover() {
  const [instances, settings] = await Promise.all([API.instances(), API.settings.get()]);
  const target = discoverTarget ? instances.find((i) => i.id === discoverTarget) : null;
  // Search scoped to the target instance's loader + MC when we have one, so hits are installable.
  const scope = target ? { loader: target.loader, mc: target.mcVersion } : {};
  const sources = [["modrinth", "Modrinth"], ["curseforge", "CurseForge"]];
  el().innerHTML = `
    <div class="page-head"><h1 class="page-title">Discover</h1></div>
    ${target ? `<div class="target-chip glass">${ico("i-plus")} Adding to <b>${esc(target.name)}</b>
        <span class="target-sub">${esc(subtitle(target))}</span>
        <button class="target-x" id="clear-target">Any instance</button></div>` : ""}
    <div class="source-toggle"><div class="seg" id="disc-source">${sources.map(([id, label]) =>
      `<button data-src="${id}" class="${id === discoverSource ? "on" : ""}">${label}</button>`).join("")}</div></div>
    <div class="searchbar glass">${ico("i-search")}<input id="q" placeholder="Search mods on ${discoverSource === "curseforge" ? "CurseForge" : "Modrinth"}…" autofocus /></div>
    <div id="results" class="results"></div>`;
  if (target) document.getElementById("clear-target").onclick = () => { discoverTarget = null; renderDiscover(); };
  const q = document.getElementById("q");
  const run = async () => {
    const box = document.getElementById("results");
    // CurseForge needs the user's own API key; guide them to Settings instead of erroring.
    if (discoverSource === "curseforge" && !settings.curseforgeKey) {
      box.innerHTML = `<div class="empty-line">Browsing CurseForge needs your CurseForge API key. Add one in <a data-goto="settings">Settings</a>.</div>`;
      box.querySelectorAll("[data-goto]").forEach((n) => n.addEventListener("click", () => navigate(n.dataset.goto)));
      return;
    }
    box.innerHTML = `<div class="empty-line">Searching…</div>`;
    try {
      const hits = discoverSource === "curseforge"
        ? await API.searchCurseforge({ query: q.value, type: "mod", ...scope })
        : await API.search({ query: q.value, type: "mod", ...scope });
      box.innerHTML = hits.map(hitRow).join("") || `<div class="empty-line">No results.</div>`;
      bindAdd(box);
    } catch (e) { box.innerHTML = `<div class="empty-line">Search failed: ${esc(e.message)}</div>`; }
  };
  document.querySelectorAll("#disc-source button").forEach((b) => b.onclick = () => {
    if (b.dataset.src === discoverSource) return;
    discoverSource = b.dataset.src;
    renderDiscover();
  });
  q.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 280); };
  run();
}

const hitRow = (h) => `
  <div class="glass hit-row">
    ${h.icon ? `<img class="hit-icon" src="${esc(h.icon)}" />` : `<div class="hit-icon ph">${ico("i-grid")}</div>`}
    <div class="hit-meta">
      <div class="hit-title">${esc(h.title)} <span class="hit-author">by ${esc(h.author || "—")}</span></div>
      <div class="hit-desc">${esc(h.description || "")}</div>
    </div>
    <div class="hit-side">
      <div class="hit-dl">${ico("i-download")} ${fmtCount(h.downloads || 0)}</div>
      <button class="btn-accent hit-add" data-add="${esc(h.id)}" data-title="${esc(h.title)}" data-source="${esc(h.source || "modrinth")}">${ico("i-plus")} Add</button>
    </div>
  </div>`;

// Wire each result's "Add" button: choose a target instance (or use the pinned one), install.
function bindAdd(container) {
  container.querySelectorAll("[data-add]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const instanceId = await pickInstance(b);
    if (!instanceId) return;
    await installTo(instanceId, b.dataset.add, b.dataset.title, b, b.dataset.source);
  });
}

// Resolve which instance to install into: the pinned target, the only instance, or a picker.
async function pickInstance(anchor) {
  if (discoverTarget) return discoverTarget;
  const instances = await API.instances();
  if (!instances.length) { toast("Create an instance first."); return null; }
  if (instances.length === 1) return instances[0].id;
  return new Promise((resolve) => {
    const menu = document.createElement("div");
    menu.className = "picker glass";
    menu.innerHTML = `<div class="picker-h">Add to…</div>` + instances.map((i) =>
      `<button class="picker-row" data-pick="${i.id}">${esc(i.name)}<span class="picker-sub">${esc(subtitle(i))}</span></button>`).join("");
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 12) + "px";
    menu.style.right = (window.innerWidth - r.right) + "px";
    const close = (id) => { menu.remove(); document.removeEventListener("mousedown", onDoc, true); resolve(id); };
    menu.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => close(b.dataset.pick));
    function onDoc(ev) { if (!menu.contains(ev.target)) close(null); }
    setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
  });
}

async function installTo(instanceId, projectId, title, btn, source) {
  const inst = (await API.instances()).find((i) => i.id === instanceId);
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Adding…`;
  try {
    // Route by source: CurseForge mods install by numeric mod id; Modrinth by project id
    // (and resolves required dependencies). Modrinth stays the exact existing path.
    const res = source === "curseforge"
      ? await API.content.installCurseforge({ instanceId, modId: Number(projectId) })
      : await API.content.install({ instanceId, projectId });
    const extra = res.installed.length - 1;
    toast(`Added ${title}${extra > 0 ? ` + ${extra} dependenc${extra === 1 ? "y" : "ies"}` : ""} to ${inst ? inst.name : "instance"}.`);
    btn.innerHTML = `✓ Added`;
  } catch (e) {
    toast("Couldn't add: " + e.message);
    btn.disabled = false; btn.innerHTML = original;
  }
}

// Open Discover pre-targeted at an instance (from its detail page).
function openDiscoverFor(id) {
  discoverTarget = id;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.section === "discover"));
  renderDiscover();
}

// ---------- SETTINGS ----------
async function renderSettings() {
  el().innerHTML = `<div class="placeholder">${ico("i-gear")}<h2>Loading…</h2></div>`;
  const [settings, info] = await Promise.all([API.settings.get(), API.info()]);

  el().innerHTML = `
    <div class="page-head"><h1 class="page-title">Settings</h1></div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">JAVA &amp; MEMORY</span></div>
    <div class="glass settings-card">
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">Default memory</div>
          <div class="set-hint">RAM new instances start with, in megabytes. Leave blank to let Lodestone size it for you.</div>
        </div>
        <div class="set-control">
          <input id="set-ram" class="set-input num" type="number" min="512" step="256" placeholder="Auto"
            value="${settings.defaultRamMB != null ? esc(settings.defaultRamMB) : ""}" />
          <span class="set-unit">MB</span>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">Java path</div>
          <div class="set-hint">Point to your own Java binary, or leave it empty to use the Java Lodestone installs for you.</div>
        </div>
        <div class="set-control wide">
          <input id="set-java" class="set-input" type="text" spellcheck="false"
            placeholder="Use the Java Lodestone installs for you"
            value="${esc(settings.javaPath || "")}" />
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">LAUNCHER</span></div>
    <div class="glass settings-card">
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">Keep launcher open</div>
          <div class="set-hint">Stay open while Minecraft runs. Turn this off to tuck the launcher away until you quit the game.</div>
        </div>
        <button id="set-keep" class="switch ${settings.keepLauncherOpen ? "on" : ""}" role="switch"
          aria-checked="${settings.keepLauncherOpen ? "true" : "false"}" title="Keep launcher open"><span class="knob"></span></button>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">CONTENT SOURCES</span></div>
    <div class="glass settings-card">
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">CurseForge API key</div>
          <div class="set-hint">Needed to browse and import CurseForge mods and modpacks. CurseForge requires each user to bring their own key. Get a free one at <a id="set-cf-link">console.curseforge.com</a>.</div>
        </div>
        <div class="set-control wide">
          <input id="set-cf" class="set-input" type="password" spellcheck="false" autocomplete="off"
            placeholder="Paste your CurseForge API key"
            value="${esc(settings.curseforgeKey || "")}" />
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">DATA &amp; UPDATES</span></div>
    <div class="glass settings-card">
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">Data folder</div>
          <div class="set-hint">Instances, mods, and the Java runtimes all live here.</div>
        </div>
        <button class="btn-soft" id="set-open-data">${ico("i-arrow-right")} Open data folder</button>
      </div>
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">Updates</div>
          <div class="set-hint">Check the release feed for a newer Lodestone. Available in the installed desktop build.</div>
        </div>
        <button class="btn-soft" id="set-check-update">${ico("i-download")} Check for updates</button>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><span class="section-title">ABOUT</span></div>
    <div class="glass settings-card about-card">
      <div class="about-row"><span class="about-k">Platform</span><span class="about-v">${esc(info.platform)}${info.arch ? " · " + esc(info.arch) : ""}</span></div>
      <div class="about-row"><span class="about-k">Engine</span><span class="about-v">${esc(info.engine)}</span></div>
      <div class="about-row"><span class="about-k">Version</span><span class="about-v">${info.electron ? "Electron " + esc(info.electron) : esc(info.engine)}</span></div>
      <div class="about-row"><span class="about-k">Data folder</span><span class="about-v mono" title="${esc(info.dataDir)}">${esc(info.dataDir)}</span></div>
    </div>`;

  const save = async (patch, note) => {
    try { const next = await API.settings.set(patch); toast(note || "Settings saved."); return next; }
    catch (e) { toast("Couldn't save: " + e.message); }
  };

  const ram = document.getElementById("set-ram");
  ram.onchange = () => {
    const raw = ram.value.trim();
    if (raw === "") { save({ defaultRamMB: null }, "Memory set to automatic."); return; }
    const val = Math.round(Number(raw));
    if (!Number.isFinite(val)) { toast("Enter a number of megabytes, or leave it blank."); return; }
    const clamped = Math.max(512, val);
    ram.value = clamped;
    save({ defaultRamMB: clamped }, `Default memory set to ${clamped} MB.`);
  };

  const java = document.getElementById("set-java");
  java.onchange = () => {
    const val = java.value.trim();
    java.value = val;
    save({ javaPath: val }, val ? "Java path saved." : "Using the Java Lodestone installs for you.");
  };

  const keep = document.getElementById("set-keep");
  keep.onclick = () => {
    const on = !keep.classList.contains("on");
    keep.classList.toggle("on", on);
    keep.setAttribute("aria-checked", on ? "true" : "false");
    save({ keepLauncherOpen: on }, on ? "Launcher will stay open while you play." : "Launcher will tuck away while you play.");
  };

  const cf = document.getElementById("set-cf");
  cf.onchange = () => {
    const val = cf.value.trim();
    cf.value = val;
    save({ curseforgeKey: val }, val ? "CurseForge key saved." : "CurseForge key cleared.");
  };
  document.getElementById("set-cf-link").onclick = () => API.openExternal("https://console.curseforge.com/#/api-keys");

  document.getElementById("set-open-data").onclick = () => API.openDataDir();
  document.getElementById("set-check-update").onclick = () => { API.update.check(); toast("Checking for updates…"); };
}

// ---------- SERVERS ----------
const platLabel = (p) => (p === "paper" ? "Paper" : p === "fabric" ? "Fabric" : "Vanilla");
const SERVER_PLATFORMS = ["vanilla", "paper", "fabric"];
const SERVER_LOG_MAX = 600;

let serverCreating = false;
let serverDetailId = null;          // the id of the server whose console is open
let serverLogBuffer = [];           // rolling console lines for the open server
let serverSubs = [];                // active engine subscriptions (server:log / server:state)
function clearServerSubs() { serverSubs.forEach((u) => { try { u(); } catch {} }); serverSubs = []; }

// Common server.properties keys the editor exposes.
const SERVER_PROP_FIELDS = [
  { key: "motd", label: "MOTD", type: "text" },
  { key: "gamemode", label: "Gamemode", type: "select", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "difficulty", label: "Difficulty", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "max-players", label: "Max players", type: "number" },
  { key: "online-mode", label: "Online mode", type: "bool" },
  { key: "pvp", label: "PvP", type: "bool" },
];

async function renderServers() {
  clearServerSubs(); serverDetailId = null;
  el().innerHTML = `<div class="placeholder">${ico("i-server")}<h2>Loading…</h2></div>`;
  const servers = await API.servers.list();
  el().innerHTML = `
    <div class="page-head">
      <h1 class="page-title">Servers</h1>
      <div class="head-actions">
        <button class="btn-soft" id="new-server">${ico("i-plus")} New Server</button>
      </div>
    </div>
    <div id="new-server-panel"></div>
    <div class="servers-list">
      ${servers.map(serverRow).join("") || `<div class="empty-line">No servers yet. Create one to host a world for your friends.</div>`}
    </div>`;
  document.getElementById("new-server").onclick = () => { serverCreating = !serverCreating; toggleServerPanel(); };
  if (serverCreating) toggleServerPanel();

  el().querySelectorAll("[data-srvstart]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    try { await API.servers.start(b.dataset.srvstart); renderServerDetail(b.dataset.srvstart); }
    catch (err) { toast("Couldn't start: " + err.message); }
  });
  el().querySelectorAll("[data-srvstop]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation(); b.disabled = true;
    try { await API.servers.stop(b.dataset.srvstop); toast("Stopping server…"); if (!API.hasEngine) renderServers(); }
    catch (err) { b.disabled = false; toast("Couldn't stop: " + err.message); }
  });
  el().querySelectorAll("[data-srvdel]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this server and all of its files? This cannot be undone.")) return;
    try { await API.servers.remove(b.dataset.srvdel); toast("Server deleted."); renderServers(); }
    catch (err) { toast("Couldn't delete: " + err.message); }
  });
  el().querySelectorAll("[data-srvopen]").forEach((n) => n.addEventListener("click", (e) => {
    if (e.target.closest("[data-srvstart],[data-srvstop],[data-srvdel]")) return;
    renderServerDetail(n.dataset.srvopen);
  }));
}

const serverRow = (s) => `
  <div class="glass srv-row" data-srvopen="${s.id}">
    <div class="srv-icon">${ico("i-server")}</div>
    <div class="hit-meta">
      <div class="srv-name">${esc(s.name)}</div>
      <div class="srv-sub">${esc(platLabel(s.platform))} · ${esc(s.mcVersion)}</div>
    </div>
    <span class="pill ${s.running ? "live" : "idle"}">${s.running ? "RUNNING" : "STOPPED"}</span>
    <div class="srv-actions">
      ${s.running
        ? `<button class="btn-soft" data-srvstop="${s.id}">Stop</button>`
        : `<button class="btn-accent srv-play" data-srvstart="${s.id}">${ico("i-play")} Start</button>`}
      <button class="btn-ghost world-x" data-srvdel="${s.id}" title="Delete server">${ico("i-trash")}</button>
    </div>
  </div>`;

async function toggleServerPanel() {
  const panel = document.getElementById("new-server-panel");
  if (!serverCreating) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="glass new-panel"><div class="np-row"><span>Loading versions…</span></div></div>`;
  const v = await API.versions();
  panel.innerHTML = `
    <div class="glass new-panel">
      <div class="np-grid">
        <label>NAME<input id="ns-name" placeholder="My Server" /></label>
        <label>TYPE
          <div class="seg" id="ns-plat">${SERVER_PLATFORMS.map((p, i) => `<button data-p="${p}" class="${i === 0 ? "on" : ""}">${platLabel(p)}</button>`).join("")}</div>
        </label>
        <label>MINECRAFT VERSION
          <select id="ns-version">${v.releases.slice(0, 60).map((r) => `<option>${r}</option>`).join("")}</select>
        </label>
      </div>
      <div class="np-note">Lodestone downloads the server jar and accepts the Minecraft EULA on your behalf. This can take a moment.</div>
      <div class="np-actions">
        <button class="btn-ghost" id="ns-cancel">Cancel</button>
        <button class="btn-accent ns-create">${ico("i-plus")} Create</button>
      </div>
    </div>`;
  let plat = "vanilla";
  panel.querySelectorAll("#ns-plat button").forEach((b) => b.onclick = () => {
    panel.querySelectorAll("#ns-plat button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); plat = b.dataset.p;
  });
  panel.querySelector("#ns-cancel").onclick = () => { serverCreating = false; toggleServerPanel(); };
  panel.querySelector(".ns-create").onclick = async (e) => {
    const btn = e.currentTarget;
    const name = panel.querySelector("#ns-name").value;
    const mcVersion = panel.querySelector("#ns-version").value;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Creating…`;
    try {
      const s = await API.servers.create({ name, platform: plat, mcVersion });
      serverCreating = false; toast(`Created ${s.name}.`); renderServers();
    } catch (err) {
      btn.disabled = false; btn.innerHTML = `${ico("i-plus")} Create`;
      toast("Couldn't create: " + err.message);
    }
  };
}

// ---------- SERVER DETAIL (console + properties) ----------
async function renderServerDetail(id) {
  clearServerSubs();
  serverDetailId = id; serverLogBuffer = [];
  el().innerHTML = `<div class="placeholder">${ico("i-server")}<h2>Loading…</h2></div>`;
  const [servers, props, hosting] = await Promise.all([
    API.servers.list(),
    API.servers.properties(id).catch(() => ({})),
    API.servers.hosting(id).catch(() => null),
  ]);
  const s = servers.find((x) => x.id === id);
  if (!s) { navigate("servers"); return; }

  el().innerHTML = `
    <div class="page-head"><button class="btn-ghost" data-goto="servers">${ico("i-arrow-right")} Servers</button></div>
    <div class="detail-hero glass">
      <div class="inst-art lg" style="background:${accentFor(s.accent)}33">${ico("i-server")}</div>
      <div class="detail-meta">
        <div class="detail-name">${esc(s.name)}</div>
        <div class="detail-sub">${esc(platLabel(s.platform))} · ${esc(s.mcVersion)} ·
          <span id="srv-state" class="srv-state ${s.running ? "on" : ""}"><span class="dot ${s.running ? "live" : ""}"></span>${s.running ? "Running" : "Stopped"}</span></div>
        <div class="detail-actions" id="srv-detail-actions">${serverActionBtns(s)}</div>
      </div>
    </div>

    ${hostPanel(hosting)}

    <div class="section-head" style="margin-top:26px"><span class="section-title">CONSOLE</span></div>
    <div class="glass console-panel">
      <pre class="console-log" id="srv-console"></pre>
      <div class="console-input">
        <input id="srv-cmd" placeholder="${s.running ? "Type a command and press Enter (e.g. say hello)" : "Start the server to send commands"}" ${s.running ? "" : "disabled"} />
        <button class="btn-soft" id="srv-send" ${s.running ? "" : "disabled"}>Send</button>
      </div>
    </div>

    <div class="section-head" style="margin-top:26px"><span class="section-title">SERVER PROPERTIES</span></div>
    <div class="glass edit-panel">
      <div class="props-grid">${SERVER_PROP_FIELDS.map((f) => propField(f, props)).join("")}</div>
      <div class="np-actions">
        <button class="btn-accent srv-props-save" style="width:auto;padding:9px 18px">Save properties</button>
      </div>
    </div>`;

  bindCommon();
  bindServerActions(id);
  bindHostActions(id);

  // Boolean properties render as the shared toggle switch.
  el().querySelectorAll(".props-grid .switch").forEach((sw) => sw.onclick = () => {
    const on = !sw.classList.contains("on");
    sw.classList.toggle("on", on); sw.setAttribute("aria-checked", on ? "true" : "false");
  });

  const send = async () => {
    const input = document.getElementById("srv-cmd");
    const cmd = input.value.trim();
    if (!cmd) return;
    try { await API.servers.command(id, cmd); appendConsole(`> ${cmd}`); input.value = ""; }
    catch (err) { toast("Couldn't send: " + err.message); }
  };
  document.getElementById("srv-send").onclick = send;
  document.getElementById("srv-cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  el().querySelector(".srv-props-save").onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const patch = {};
    SERVER_PROP_FIELDS.forEach((f) => {
      const node = document.getElementById("prop-" + f.key);
      if (!node) return;
      patch[f.key] = f.type === "bool" ? (node.classList.contains("on") ? "true" : "false") : String(node.value).trim();
    });
    try {
      await API.servers.setProperties(id, patch);
      // The Share / Host panel has its own online-mode toggle; keep it in step with a save here.
      if (patch["online-mode"] != null) setSwitch(document.getElementById("host-online"), patch["online-mode"] === "true");
      toast("Properties saved.");
    }
    catch (err) { toast("Couldn't save: " + err.message); }
    finally { btn.disabled = false; }
  };

  // Live console + lifecycle, scoped to this server.
  serverSubs.push(API.on("server:log", (p) => { if (p.id === serverDetailId) appendConsole(p.line); }));
  serverSubs.push(API.on("server:state", (p) => { if (p.id === serverDetailId) updateServerState(p.status, p.code); }));
}

// ---------- SHARE / HOST ----------
// hostPanel(h): how friends actually join. LAN address(es) with Copy, an optional
// Tailscale address, the port, and an online-mode toggle. `h` is null in the browser
// preview or if hosting info couldn't load, in which case the panel is omitted.
function hostPanel(h) {
  if (!h) return "";
  const online = String(h.onlineMode) === "true";
  const lanRows = (h.lan && h.lan.length)
    ? h.lan.map(hostAddrRow).join("")
    : `<div class="host-empty">No local network address found. Connect to Wi-Fi or Ethernet to share on your LAN.</div>`;
  const tsRow = h.tailscale
    ? hostAddrRow(h.tailscale)
    : `<div class="host-hint">Not on a tailnet. Install Tailscale to share beyond your network.</div>`;
  return `
    <div class="section-head" style="margin-top:22px"><span class="section-title">SHARE / HOST</span></div>
    <div class="glass host-panel">
      <div class="host-block">
        <div class="host-label">${ico("i-globe")} LAN (same network)</div>
        <div class="host-rows">${lanRows}</div>
        <div class="host-note">Friends on your Wi-Fi can join at this address.</div>
      </div>
      <div class="host-block">
        <div class="host-label">${ico("i-globe")} Tailscale</div>
        <div class="host-rows">${tsRow}</div>
        <div class="host-note">A Tailscale address lets trusted friends join from anywhere, as if they were on your network.</div>
      </div>
      <div class="host-block host-meta">
        <div class="host-port">Server port <b>${esc(String(h.port))}</b></div>
        <label class="host-online">ONLINE MODE
          <button type="button" id="host-online" class="switch ${online ? "on" : ""}" role="switch" aria-checked="${online ? "true" : "false"}"><span class="knob"></span></button>
        </label>
      </div>
      <div class="host-note host-warn">Online mode on (recommended) means everyone must own Minecraft and sign in. Turning it off lets cracked or any accounts join, so only do this with people you trust.</div>
    </div>`;
}

function hostAddrRow(addr) {
  return `<div class="host-addr"><code>${esc(addr)}</code><button class="btn-soft host-copy" data-copy="${esc(addr)}">Copy</button></div>`;
}

function setSwitch(node, on) {
  if (!node) return;
  node.classList.toggle("on", on);
  node.setAttribute("aria-checked", on ? "true" : "false");
}

function bindHostActions(id) {
  el().querySelectorAll(".host-copy").forEach((b) => b.onclick = async () => {
    const text = b.dataset.copy || "";
    try {
      await navigator.clipboard.writeText(text);
      const prev = b.textContent; b.textContent = "Copied";
      setTimeout(() => { if (b.textContent === "Copied") b.textContent = prev; }, 1400);
    } catch { toast("Couldn't copy automatically. Address: " + text); }
  });

  const sw = document.getElementById("host-online");
  if (sw) sw.onclick = async () => {
    const on = !sw.classList.contains("on");
    setSwitch(sw, on);
    try {
      await API.servers.setOnlineMode(id, on);
      // Mirror onto the properties editor's online-mode field so a later Save agrees.
      setSwitch(document.getElementById("prop-online-mode"), on);
      toast(on ? "Online mode on. Players must own Minecraft and sign in."
               : "Online mode off. Any account can join. Use only with people you trust.");
    } catch (err) {
      setSwitch(sw, !on);   // revert on failure
      toast("Couldn't change online mode: " + err.message);
    }
  };
}

function propField(f, props) {
  const val = props && props[f.key] != null ? props[f.key] : "";
  if (f.type === "select") {
    const opts = f.options.map((o) => `<option${String(val) === o ? " selected" : ""}>${o}</option>`).join("");
    return `<label>${f.label.toUpperCase()}<select id="prop-${f.key}">${opts}</select></label>`;
  }
  if (f.type === "bool") {
    const on = String(val) === "true";
    return `<label class="prop-bool">${f.label.toUpperCase()}
      <button type="button" id="prop-${f.key}" class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}"><span class="knob"></span></button></label>`;
  }
  const type = f.type === "number" ? "number" : "text";
  return `<label>${f.label.toUpperCase()}<input id="prop-${f.key}" type="${type}" value="${esc(val)}" /></label>`;
}

function serverActionBtns(s) {
  return s.running
    ? `<button class="btn-soft srv-stop" data-srvstop="${s.id}">${ico("i-server")} Stop server</button>`
    : `<button class="btn-accent srv-play" data-srvstart="${s.id}">${ico("i-play")} Start server</button>`;
}

function bindServerActions(id) {
  const start = el().querySelector(`[data-srvstart="${id}"]`);
  const stop = el().querySelector(`[data-srvstop="${id}"]`);
  if (start) start.onclick = async () => {
    start.disabled = true; start.innerHTML = `<span class="spinner"></span> Starting…`;
    try { await API.servers.start(id); appendConsole("[Lodestone] Starting server…"); if (!API.hasEngine) renderServerDetail(id); }
    catch (err) { toast("Couldn't start: " + err.message); updateServerState("stopped"); }
  };
  if (stop) stop.onclick = async () => {
    stop.disabled = true; stop.innerHTML = `<span class="spinner"></span> Stopping…`;
    try { await API.servers.stop(id); appendConsole("[Lodestone] Stopping server…"); if (!API.hasEngine) renderServerDetail(id); }
    catch (err) { stop.disabled = false; toast("Couldn't stop: " + err.message); }
  };
}

function appendConsole(line) {
  serverLogBuffer.push(line);
  if (serverLogBuffer.length > SERVER_LOG_MAX) serverLogBuffer.shift();
  const pre = document.getElementById("srv-console");
  if (pre) { pre.textContent = serverLogBuffer.join("\n"); pre.scrollTop = pre.scrollHeight; }
}

function updateServerState(status, code) {
  const running = status === "running";
  const st = document.getElementById("srv-state");
  if (st) { st.className = "srv-state" + (running ? " on" : ""); st.innerHTML = `<span class="dot ${running ? "live" : ""}"></span>${running ? "Running" : "Stopped"}`; }
  const cmd = document.getElementById("srv-cmd"); const send = document.getElementById("srv-send");
  if (cmd) { cmd.disabled = !running; cmd.placeholder = running ? "Type a command and press Enter (e.g. say hello)" : "Start the server to send commands"; }
  if (send) send.disabled = !running;
  const actions = document.getElementById("srv-detail-actions");
  if (actions) { actions.innerHTML = serverActionBtns({ id: serverDetailId, running }); bindServerActions(serverDetailId); }
  if (!running) appendConsole(code != null && code !== 0 ? `[Lodestone] Server stopped (exit code ${code}).` : "[Lodestone] Server stopped.");
}

// ---------- nav ----------
function placeholder(title) {
  return `<div class="placeholder">${ico("i-grid")}<h2>${title}</h2><p>Ports next — Home, Instances &amp; Discover are live.</p></div>`;
}

function bindCommon() {
  el().querySelectorAll("[data-play]").forEach((n) => n.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const r = await API.launch(n.dataset.play);
      if (!r.started) toast(r.message || "");
    } catch (err) { toast("Launch failed: " + err.message); }
  }));
  el().querySelectorAll("[data-goto]").forEach((n) => n.addEventListener("click", () => navigate(n.dataset.goto)));
}

function navigate(section) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.section === section));
  if (section === "discover") discoverTarget = null;   // sidebar Discover = browse for any instance
  ({ home: renderHome, instances: renderInstances, discover: renderDiscover, servers: renderServers, cloud: renderCloud, friends: renderFriends, settings: renderSettings }[section] || (() => el().innerHTML = placeholder(section[0].toUpperCase() + section.slice(1))))();
}

// ---------- Command palette (Ctrl/Cmd-K) ----------
// A centered quick-action overlay. It builds its action list fresh on every open (so
// instance names stay current), filters by case-insensitive substring, and is fully
// keyboard-navigable (Up/Down to move, Enter to run, Escape to close). Its own element
// lives on <body> — separate from #modal and #overlay so it never clashes with them.
function setupCommandPalette() {
  const root = document.createElement("div");
  root.className = "cmdk-root";
  root.hidden = true;
  root.innerHTML = `
    <div class="cmdk-panel glass">
      <div class="cmdk-search">${ico("i-search")}<input id="cmdk-input" placeholder="Type a command or search…" autocomplete="off" spellcheck="false" /></div>
      <div class="cmdk-list" id="cmdk-list"></div>
    </div>`;
  document.body.appendChild(root);

  const input = root.querySelector("#cmdk-input");
  const listEl = root.querySelector("#cmdk-list");
  let actions = [];    // every action available for the current open
  let filtered = [];   // actions matching the query
  let sel = 0;         // highlighted index within `filtered`
  let open = false;

  // Fetch instances so per-instance actions (Play / Repair / Update) reflect reality.
  async function buildActions() {
    const nav = [
      { label: "Go to Home", hint: "Navigate", run: () => navigate("home") },
      { label: "Go to Instances", hint: "Navigate", run: () => navigate("instances") },
      { label: "Go to Discover", hint: "Navigate", run: () => navigate("discover") },
      { label: "Go to Servers", hint: "Navigate", run: () => navigate("servers") },
      { label: "Go to Settings", hint: "Navigate", run: () => navigate("settings") },
      { label: "New instance", hint: "Create", run: () => { creating = true; navigate("instances"); } },
      { label: "Check for updates", hint: "Launcher", run: () => { API.update.check(); toast("Checking for updates…"); } },
    ];
    let instances = [];
    try { instances = await API.instances(); } catch { instances = []; }
    for (const i of instances) {
      nav.push({ label: `Play ${i.name}`, hint: subtitle(i), run: async () => {
        try { const r = await API.launch(i.id); if (!r.started) toast(r.message || ""); }
        catch (e) { toast("Launch failed: " + e.message); }
      } });
      nav.push({ label: `Repair ${i.name}`, hint: "Clear cached game files", run: async () => {
        toast(`Repairing ${i.name}…`);
        try {
          const res = await API.instance.repair(i.id);
          const n = (res.cleared || []).length;
          toast(n
            ? `Repaired ${i.name}. Cleared ${n} cached folder${n === 1 ? "" : "s"}; the next launch reinstalls them.`
            : `${i.name} had no cached game files to clear.`);
        } catch (e) { toast("Repair failed: " + e.message); }
      } });
      nav.push({ label: `Update mods in ${i.name}`, hint: "Update all content", run: async () => {
        toast(`Checking ${i.name} for content updates…`);
        try {
          const res = await API.instance.updateAll(i.id);
          const u = (res.updated || []).length;
          toast(u
            ? `Updated ${u} item${u === 1 ? "" : "s"} in ${i.name}.`
            : `Everything in ${i.name} is already up to date.`);
        } catch (e) { toast("Update failed: " + e.message); }
      } });
    }
    return nav;
  }

  function render() {
    if (!filtered.length) { listEl.innerHTML = `<div class="cmdk-empty">No matching commands.</div>`; return; }
    if (sel >= filtered.length) sel = filtered.length - 1;
    if (sel < 0) sel = 0;
    listEl.innerHTML = filtered.map((a, idx) => `
      <button class="cmdk-item${idx === sel ? " on" : ""}" data-idx="${idx}">
        <span class="cmdk-label">${esc(a.label)}</span>
        ${a.hint ? `<span class="cmdk-hint">${esc(a.hint)}</span>` : ""}
      </button>`).join("");
    listEl.querySelectorAll(".cmdk-item").forEach((b) => {
      b.addEventListener("mousemove", () => { const i = Number(b.dataset.idx); if (i !== sel) { sel = i; highlight(); } });
      b.addEventListener("click", () => choose(Number(b.dataset.idx)));
    });
    scrollToSel();
  }

  function highlight() {
    listEl.querySelectorAll(".cmdk-item").forEach((b) => b.classList.toggle("on", Number(b.dataset.idx) === sel));
    scrollToSel();
  }
  function scrollToSel() {
    const active = listEl.querySelector(".cmdk-item.on");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function applyFilter() {
    const q = input.value.trim().toLowerCase();
    filtered = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions.slice();
    sel = 0;
    render();
  }

  function choose(idx) {
    const a = filtered[idx];
    if (!a) return;
    close();
    Promise.resolve().then(() => a.run());   // run after the palette has closed
  }

  async function openPalette() {
    if (open) return;
    open = true;
    input.value = "";
    actions = []; filtered = []; sel = 0;
    listEl.innerHTML = `<div class="cmdk-empty">Loading…</div>`;
    root.hidden = false;
    input.focus();
    const built = await buildActions();
    if (!open) return;   // user closed it while we were loading
    actions = built;
    applyFilter();
  }
  function close() {
    if (!open) return;
    open = false;
    root.hidden = true;
    input.blur();
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      open ? close() : openPalette();
      return;
    }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (filtered.length) { sel = (sel + 1) % filtered.length; highlight(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (filtered.length) { sel = (sel - 1 + filtered.length) % filtered.length; highlight(); } }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
  });
  input.addEventListener("input", applyFilter);
  root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });   // click the backdrop to dismiss
}

// ---------- Account / sign-in ----------
async function renderAccount() {
  const acc = await API.account.get();
  const node = document.getElementById("account");
  if (acc) {
    node.classList.remove("signin");
    node.innerHTML = `
      <img class="avatar" src="https://mc-heads.net/avatar/${esc(acc.uuid.replace(/-/g, ""))}/64" />
      <div class="account-meta"><div class="account-name">${esc(acc.name)}</div><div class="account-sub">Signed in</div></div>
      <button class="account-more" id="acc-out" title="Sign out">⋯</button>`;
    document.getElementById("acc-out").onclick = async () => { await API.account.signOut(); toast("Signed out."); renderAccount(); };
  } else {
    node.classList.add("signin");
    node.innerHTML = `<button class="signin-btn" id="acc-in">${ico("i-play")} Sign in with Microsoft</button>`;
    document.getElementById("acc-in").onclick = signIn;
  }
}

async function signIn() {
  let device;
  try { device = await API.account.start(); }
  catch (e) { return toast("Couldn't start sign-in: " + e.message); }
  showModal(`
    <div class="signin-card">
      <div class="signin-h">Sign in to Microsoft</div>
      <p>Open this page and enter the code (we'll open it for you):</p>
      <a class="signin-link" id="si-link">${esc(device.verificationUri)}</a>
      <div class="signin-code">${esc(device.userCode)}</div>
      <div class="signin-wait"><span class="spinner"></span> Waiting for you to finish in the browser…</div>
      <div class="np-actions"><button class="btn-ghost" id="si-cancel">Cancel</button></div>
    </div>`);
  document.getElementById("si-link").onclick = () => API.openExternal(device.verificationUri);
  API.openExternal(device.verificationUri);
  let cancelled = false;
  document.getElementById("si-cancel").onclick = () => { cancelled = true; hideModal(); };
  try {
    const acc = await API.account.complete(device);
    if (cancelled) return;
    hideModal(); toast(`Signed in as ${acc.name}.`); renderAccount();
  } catch (e) {
    if (!cancelled) { hideModal(); toast("Sign-in failed: " + e.message); }
  }
}

function showModal(html) { const m = document.getElementById("modal"); m.innerHTML = `<div class="modal-card glass">${html}</div>`; m.hidden = false; }
function hideModal() { const m = document.getElementById("modal"); m.hidden = true; m.innerHTML = ""; }

// ---------- Cloud account (Lodestone social/sync identity) ----------
// Distinct from the Minecraft sidebar widget above: this is the account that
// powers friends, chat, squads and cross-machine sync. Three states: backend
// not configured yet, signed out, and signed in.
let cloudAuthState = null;   // last { signedIn, profile } pushed from the engine

async function renderCloud() {
  let status;
  try { status = await API.cloud.status(); }
  catch (e) { el().innerHTML = `<div class="placeholder">${ico("i-user")}<h2>Account</h2><p>${esc(e.message)}</p></div>`; return; }
  cloudAuthState = { signedIn: status.signedIn, profile: status.profile };

  if (!status.configured) {
    el().innerHTML = `
      <div class="cloud-wrap">
        <div class="cloud-head"><h1>Account</h1><p class="cloud-sub">Friends, chat, squads and cross-machine sync run on a Lodestone account.</p></div>
        <div class="cloud-card glass cloud-setup">
          ${ico("i-globe")}
          <h2>Cloud backend not set up yet</h2>
          <p>The launcher works fully offline without this. To turn on accounts and the social features, connect a Supabase project once — it takes about two minutes.</p>
          <p class="cloud-hint">See <b>SETUP.md</b> in the repo for the exact steps, then restart Lodestone.</p>
        </div>
      </div>`;
    return;
  }

  if (!status.signedIn) { renderCloudSignedOut(); return; }
  renderCloudSignedIn(status);
}

function renderCloudSignedOut() {
  el().innerHTML = `
    <div class="cloud-wrap">
      <div class="cloud-head"><h1>Account</h1><p class="cloud-sub">Sign in to sync your instances and connect with friends.</p></div>
      <div class="cloud-card glass">
        <div class="cloud-tabs">
          <button class="cloud-tab on" data-ctab="in">Sign in</button>
          <button class="cloud-tab" data-ctab="up">Create account</button>
        </div>
        <form class="cloud-form" id="cloud-form" autocomplete="off">
          <label class="cloud-field cloud-up" hidden><span>Username</span><input id="cf-username" placeholder="how friends find you" spellcheck="false" /></label>
          <label class="cloud-field"><span>Email</span><input id="cf-email" type="email" placeholder="you@example.com" spellcheck="false" /></label>
          <label class="cloud-field"><span>Password</span><input id="cf-password" type="password" placeholder="at least 8 characters" /></label>
          <div class="cloud-err" id="cf-err" hidden></div>
          <button class="btn-soft cloud-submit" id="cf-submit" type="submit">Sign in</button>
        </form>
      </div>
    </div>`;

  let mode = "in";
  const err = document.getElementById("cf-err");
  const setMode = (m) => {
    mode = m;
    el().querySelectorAll(".cloud-tab").forEach((t) => t.classList.toggle("on", t.dataset.ctab === m));
    el().querySelectorAll(".cloud-up").forEach((n) => (n.hidden = m !== "up"));
    document.getElementById("cf-submit").textContent = m === "up" ? "Create account" : "Sign in";
    err.hidden = true;
  };
  el().querySelectorAll(".cloud-tab").forEach((t) => (t.onclick = () => setMode(t.dataset.ctab)));

  document.getElementById("cloud-form").onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const email = document.getElementById("cf-email").value.trim();
    const password = document.getElementById("cf-password").value;
    const username = document.getElementById("cf-username").value.trim();
    const btn = document.getElementById("cf-submit");
    btn.disabled = true; btn.textContent = mode === "up" ? "Creating…" : "Signing in…";
    try {
      if (mode === "up") {
        const r = await API.cloud.signUp({ email, password, username });
        if (r.needsConfirmation) { toast("Check your email to confirm, then sign in."); setMode("in"); }
        else { toast("Account created."); renderCloud(); }
      } else {
        await API.cloud.signIn({ email, password });
        toast("Signed in."); renderCloud();
      }
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = mode === "up" ? "Create account" : "Sign in";
    }
  };
}

function renderCloudSignedIn(status) {
  const p = status.profile || {};
  const mcLinked = !!p.minecraft_uuid;
  const avatar = mcLinked
    ? `<img class="cloud-avatar" src="https://mc-heads.net/avatar/${esc(p.minecraft_uuid.replace(/-/g, ""))}/96" />`
    : `<div class="cloud-avatar cloud-avatar-empty">${ico("i-user")}</div>`;
  el().innerHTML = `
    <div class="cloud-wrap">
      <div class="cloud-head"><h1>Account</h1><p class="cloud-sub">Your Lodestone identity for friends &amp; sync.</p></div>
      <div class="cloud-card glass cloud-profile">
        ${avatar}
        <div class="cloud-ident">
          <div class="cloud-name">${esc(p.display_name || p.username || "Player")}</div>
          <div class="cloud-handle">@${esc(p.username || "player")}</div>
          <div class="cloud-email">${esc(status.email || "")}</div>
        </div>
        <button class="btn-ghost" id="cloud-out">Sign out</button>
      </div>

      <div class="cloud-card glass">
        <h2 class="cloud-h2">Profile</h2>
        <label class="cloud-field"><span>Display name</span><input id="cp-display" value="${esc(p.display_name || "")}" placeholder="shown to friends" /></label>
        <label class="cloud-field"><span>Username</span><input id="cp-username" value="${esc(p.username || "")}" spellcheck="false" /></label>
        <div class="cloud-err" id="cp-err" hidden></div>
        <button class="btn-soft" id="cp-save">Save profile</button>
      </div>

      <div class="cloud-card glass cloud-mc">
        <div class="cloud-mc-row">
          <div>
            <h2 class="cloud-h2">Minecraft</h2>
            <p class="cloud-sub-inline">${mcLinked
              ? `Linked to <b>${esc(p.minecraft_name || "your account")}</b> — friends see this name and skin.`
              : `Link your Minecraft account so friends recognize you by your in-game name and skin.`}</p>
          </div>
          <button class="btn-soft" id="cloud-linkmc">${ico("i-link")} ${mcLinked ? "Relink" : "Link Minecraft"}</button>
        </div>
      </div>

      <div class="cloud-card glass cloud-soon">
        <p><b>Friends, chat &amp; sync</b> light up here as they ship — this account is what they run on.</p>
      </div>
    </div>`;

  document.getElementById("cloud-out").onclick = async () => {
    await API.cloud.signOut(); toast("Signed out."); renderCloud();
  };
  document.getElementById("cp-save").onclick = async () => {
    const err = document.getElementById("cp-err"); err.hidden = true;
    const display_name = document.getElementById("cp-display").value.trim();
    const username = document.getElementById("cp-username").value.trim();
    const btn = document.getElementById("cp-save"); btn.disabled = true; btn.textContent = "Saving…";
    try { await API.cloud.updateProfile({ display_name, username }); toast("Profile saved."); renderCloud(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = "Save profile"; }
  };
  document.getElementById("cloud-linkmc").onclick = async () => {
    const mc = await API.account.get();
    if (!mc) return toast("Sign in to Minecraft first (bottom-left), then link it.");
    try { await API.cloud.linkMinecraft(); toast(`Linked ${mc.name}.`); renderCloud(); }
    catch (ex) { toast("Couldn't link: " + ex.message); }
  };
}

// Keep the Account view + nav badge honest as the session changes / refreshes.
function setupCloud() {
  API.on("cloud:auth", (s) => {
    cloudAuthState = s;
    const active = document.querySelector('.nav-item[data-section="cloud"].is-active');
    if (active) renderCloud();
  });
}

// ========================================================================
// Friends + Presence (Vertical B) — search people, requests, live status.
// ========================================================================
let friendsData = { friends: [], incoming: [], outgoing: [], blocked: [] };
let friendsPresence = {};   // userId -> { status, activity, minecraft_name, online_at }
let friendsSearchSeq = 0;   // guards out-of-order async search results

const onFriendsView = () => !!document.querySelector('.nav-item[data-section="friends"].is-active');

function friendAvatar(u, size) {
  const s = size || 40;
  return u && u.minecraft_uuid
    ? `<img class="friend-avatar" src="https://mc-heads.net/avatar/${esc(u.minecraft_uuid.replace(/-/g, ""))}/${s}" />`
    : `<div class="friend-avatar friend-avatar-empty">${ico("i-user")}</div>`;
}
function friendIdentity(u) {
  const name = esc((u && (u.display_name || u.username || u.minecraft_name)) || "Player");
  const handle = u && u.username ? `@${esc(u.username)}` : (u && u.minecraft_name ? esc(u.minecraft_name) : "");
  return `<div class="friend-name">${name}</div>${handle ? `<div class="friend-handle">${handle}</div>` : ""}`;
}
function agoText(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function friendPresenceHtml(u) {
  const pres = u && friendsPresence[u.id];
  if (pres && pres.status === "online") {
    return `<div class="friend-status online"><span class="pdot on"></span>${esc(pres.activity || "In launcher")}</div>`;
  }
  const seen = agoText(u && u.last_seen_at);
  return `<div class="friend-status"><span class="pdot"></span>${seen ? "Last seen " + seen : "Offline"}</div>`;
}

async function renderFriends() {
  let status;
  try { status = await API.cloud.status(); }
  catch (e) { el().innerHTML = `<div class="placeholder">${ico("i-users")}<h2>Friends</h2><p>${esc(e.message)}</p></div>`; return; }

  if (!status.configured || !status.signedIn) {
    el().innerHTML = `
      <div class="cloud-wrap">
        <div class="cloud-head"><h1>Friends</h1><p class="cloud-sub">See who's online and what they're playing.</p></div>
        <div class="cloud-card glass cloud-setup">
          ${ico("i-users")}
          <h2>${status.configured ? "Sign in to see your friends" : "Cloud backend not set up yet"}</h2>
          <p>${status.configured
            ? "Friends and presence run on your Lodestone account. Head to Account to sign in."
            : "Connect a Supabase project once to turn on accounts and the social features — the launcher works fully offline without it."}</p>
          <button class="btn-soft" id="fr-goto-account">Go to Account</button>
        </div>
      </div>`;
    const b = document.getElementById("fr-goto-account");
    if (b) b.onclick = () => navigate("cloud");
    return;
  }

  el().innerHTML = `
    <div class="cloud-wrap friends-wrap">
      <div class="cloud-head"><h1>Friends</h1><p class="cloud-sub">See who's online and what they're playing.</p></div>

      <div class="cloud-card glass friends-find">
        <div class="searchbar friends-searchbar">${ico("i-search")}<input id="fr-search" placeholder="Find people by name or Minecraft name" spellcheck="false" autocomplete="off" /></div>
        <div class="friends-results" id="fr-results" hidden></div>
      </div>

      <div id="fr-requests"></div>

      <div class="cloud-card glass">
        <h2 class="cloud-h2">Your friends <span class="friends-count" id="fr-count"></span></h2>
        <div id="fr-list"><div class="friends-empty">Loading…</div></div>
      </div>
    </div>`;

  const input = document.getElementById("fr-search");
  const results = document.getElementById("fr-results");
  input.addEventListener("input", () => runFriendSearch(input.value, results));
  await refreshFriends();
}

async function refreshFriends() {
  try { friendsData = await API.cloud.friends.list(); }
  catch { friendsData = { friends: [], incoming: [], outgoing: [], blocked: [] }; }
  renderFriendLists();
}

// Rebuild the requests + friends lists from the cached data + presence roster.
// A no-op (and safe) when the Friends view isn't mounted.
function renderFriendLists() {
  const reqEl = document.getElementById("fr-requests");
  const listEl = document.getElementById("fr-list");
  const countEl = document.getElementById("fr-count");
  if (!reqEl || !listEl) return;

  const { friends, incoming, outgoing } = friendsData;

  let reqHtml = "";
  if (incoming.length) {
    reqHtml += `<div class="cloud-card glass"><h2 class="cloud-h2">Requests <span class="friends-count">${incoming.length}</span></h2>`;
    reqHtml += incoming.map((r) => `
      <div class="friend-row">
        ${friendAvatar(r.user)}
        <div class="friend-ident">${friendIdentity(r.user)}<div class="friend-status"><span class="pdot"></span>wants to be friends</div></div>
        <div class="friend-actions">
          <button class="btn-accent friends-btn" data-fr-accept="${esc(r.id)}">Accept</button>
          <button class="btn-soft friends-btn" data-fr-decline="${esc(r.id)}">Decline</button>
        </div>
      </div>`).join("");
    reqHtml += `</div>`;
  }
  if (outgoing.length) {
    reqHtml += `<div class="cloud-card glass"><h2 class="cloud-h2">Sent <span class="friends-count">${outgoing.length}</span></h2>`;
    reqHtml += outgoing.map((r) => `
      <div class="friend-row">
        ${friendAvatar(r.user)}
        <div class="friend-ident">${friendIdentity(r.user)}<div class="friend-status"><span class="pdot"></span>Pending…</div></div>
        <div class="friend-actions"><button class="btn-soft friends-btn" data-fr-cancel="${esc(r.id)}">Cancel</button></div>
      </div>`).join("");
    reqHtml += `</div>`;
  }
  reqEl.innerHTML = reqHtml;

  if (countEl) countEl.textContent = friends.length ? String(friends.length) : "";
  if (!friends.length) {
    listEl.innerHTML = `<div class="friends-empty">No friends yet — search above to add someone.</div>`;
  } else {
    const online = (u) => (friendsPresence[u.id] && friendsPresence[u.id].status === "online" ? 0 : 1);
    const sorted = friends.slice().sort((a, b) => online(a.user) - online(b.user));
    listEl.innerHTML = sorted.map((f) => `
      <div class="friend-row">
        ${friendAvatar(f.user)}
        <div class="friend-ident">${friendIdentity(f.user)}${friendPresenceHtml(f.user)}</div>
        <div class="friend-actions">
          <button class="btn-soft friends-btn" data-fr-block="${esc(f.user.id)}" title="Block">Block</button>
          <button class="btn-soft friends-btn friends-icon-btn" data-fr-remove="${esc(f.id)}" title="Remove friend">${ico("i-trash")}</button>
        </div>
      </div>`).join("");
  }

  bindFriendActions();
}

async function friendAction(btn, fn, okMsg) {
  btn.disabled = true;
  try { await fn(); toast(okMsg); await refreshFriends(); rerunFriendSearch(); }
  catch (e) { toast(e.message); btn.disabled = false; }
}
function bindFriendActions() {
  document.querySelectorAll("[data-fr-accept]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.respond(b.dataset.frAccept, true), "Accepted.")));
  document.querySelectorAll("[data-fr-decline]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.respond(b.dataset.frDecline, false), "Declined.")));
  document.querySelectorAll("[data-fr-cancel]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.remove(b.dataset.frCancel), "Request cancelled.")));
  document.querySelectorAll("[data-fr-remove]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.remove(b.dataset.frRemove), "Removed.")));
  document.querySelectorAll("[data-fr-block]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.block(b.dataset.frBlock), "Blocked.")));
}

// People search — debounced-by-sequence: only the latest query's results render.
async function runFriendSearch(query, resultsEl) {
  const q = (query || "").trim();
  const seq = ++friendsSearchSeq;
  if (q.length < 2) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
  resultsEl.hidden = false;
  resultsEl.innerHTML = `<div class="friends-empty">Searching…</div>`;
  let hits = [];
  try { hits = await API.cloud.friends.search(q); }
  catch (e) { if (seq === friendsSearchSeq) resultsEl.innerHTML = `<div class="friends-empty">${esc(e.message)}</div>`; return; }
  if (seq !== friendsSearchSeq) return;
  if (!hits.length) { resultsEl.innerHTML = `<div class="friends-empty">No one found.</div>`; return; }
  resultsEl.innerHTML = hits.map((h) => `
    <div class="friend-row friend-hit">
      ${friendAvatar(h)}
      <div class="friend-ident">${friendIdentity(h)}</div>
      <div class="friend-actions">${friendHitAction(h)}</div>
    </div>`).join("");
  resultsEl.querySelectorAll("[data-fr-add]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.request(b.dataset.frAdd), "Request sent.")));
  resultsEl.querySelectorAll("[data-fr-accept-hit]").forEach((b) => (b.onclick = () => friendAction(b, () => API.cloud.friends.respond(b.dataset.frAcceptHit, true), "Accepted.")));
}
function friendHitAction(h) {
  const rel = h.relation;
  if (!rel) return `<button class="btn-accent friends-btn" data-fr-add="${esc(h.id)}">Add</button>`;
  if (rel.status === "accepted") return `<span class="friends-tag">Friends</span>`;
  if (rel.status === "blocked") return `<span class="friends-tag muted">Blocked</span>`;
  if (rel.incoming) return `<button class="btn-accent friends-btn" data-fr-accept-hit="${esc(rel.id)}">Accept</button>`;
  return `<span class="friends-tag muted">Requested</span>`;
}
function rerunFriendSearch() {
  const input = document.getElementById("fr-search");
  const results = document.getElementById("fr-results");
  if (input && results && input.value.trim().length >= 2) runFriendSearch(input.value, results);
}

// Live updates: friend requests/accepts and presence pushes re-render in place.
function setupFriends() {
  API.on("cloud:friends", (data) => {
    if (data) friendsData = data;
    if (onFriendsView()) { renderFriendLists(); rerunFriendSearch(); }
  });
  API.on("cloud:presence", (payload) => {
    friendsPresence = (payload && payload.online) || {};
    if (onFriendsView()) renderFriendLists();
  });
}

// ---------- Launch overlay ----------
function setupLaunchOverlay() {
  const ov = document.getElementById("overlay");
  const logs = [];
  const phaseLabel = { resolving: "Resolving", assets: "Downloading assets", java: "Downloading Java", loader: "Installing loader", server: "Server" };
  const show = (html) => { ov.innerHTML = html; ov.hidden = false; };

  API.on("launch:state", (s) => {
    if (s.status === "installing" || s.status === "running") {
      logs.length = 0;
      show(`<div class="launch-card glass">
        <div class="launch-title">${ico("i-play")} ${s.status === "running" ? "Starting Minecraft…" : "Preparing…"}</div>
        <div class="bar"><div class="bar-fill" id="lp"></div></div>
        <div class="launch-phase" id="lphase">Getting ready…</div>
        <pre class="launch-log" id="llog"></pre>
        <button class="btn-soft" id="lstop">Stop</button></div>`);
      document.getElementById("lstop").onclick = () => API.stop(s.id);
    } else if (s.status === "idle") {
      ov.hidden = true;
      if (s.code != null && s.code !== 0) toast("Minecraft exited (code " + s.code + ").");
    }
  });
  API.on("launch:progress", (p) => {
    const bar = document.getElementById("lp"); const ph = document.getElementById("lphase");
    if (bar && p.total) bar.style.width = Math.round((p.done / p.total) * 100) + "%";
    if (ph) ph.textContent = `${phaseLabel[p.phase] || p.phase} — ${p.done}/${p.total}`;
  });
  API.on("launch:log", (l) => {
    const log = document.getElementById("llog");
    logs.push(l.line); if (logs.length > 9) logs.shift();
    if (log) { log.textContent = logs.join("\n"); }
    const ph = document.getElementById("lphase");
    if (ph && /Setting user:|LWJGL|Sound engine|OpenAL/.test(l.line)) ph.textContent = "Almost there…";
  });
}

// ---------- Auto-update banner ----------
function setupUpdates() {
  const bar = document.getElementById("update-banner");
  if (!bar) return;
  API.on("update:state", (s) => {
    if (s.status === "downloading") {
      bar.hidden = false;
      bar.innerHTML = `<span class="spinner"></span><span class="ub-text">Downloading update<span class="ub-sub">${s.percent ? s.percent + "%" : ""}</span></span>`;
    } else if (s.status === "ready") {
      bar.hidden = false;
      bar.innerHTML = `<span class="ub-text">Update ready<span class="ub-sub">v${esc(s.version || "")}</span></span>
        <button class="ub-btn" id="ub-restart">Restart</button>
        <button class="ub-x" id="ub-dismiss" title="Later">×</button>`;
      document.getElementById("ub-restart").onclick = () => API.update.install();
      document.getElementById("ub-dismiss").onclick = () => { bar.hidden = true; };
    } else {
      // checking / current / error — stay quiet; no update to act on.
      bar.hidden = true;
    }
  });
}

document.querySelectorAll(".nav-item").forEach((btn) => btn.addEventListener("click", () => navigate(btn.dataset.section)));
renderAccount();
setupLaunchOverlay();
setupUpdates();
setupCloud();
setupFriends();
setupCommandPalette();
navigate("home");
