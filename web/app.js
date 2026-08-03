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

// Loaders have real capitalisation ("NeoForge", not "Neoforge") — naive
// first-letter casing gets three of the five wrong.
const LOADER_NAMES = { vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };
function loaderLabel(l) { return LOADER_NAMES[String(l).toLowerCase()] || (l ? l[0].toUpperCase() + l.slice(1) : "Vanilla"); }
function subtitle(i) { return i.loader === "vanilla" ? i.mcVersion : `${loaderLabel(i.loader)} ${i.mcVersion}`; }
// [Design overhaul] "Played …" line for instance cards (lastPlayed is ms or null).
function playedLabel(i) {
  if (!i.lastPlayed) return "Not played yet";
  const days = Math.floor((Date.now() - i.lastPlayed) / 86400000);
  if (days <= 0) return "Played today";
  if (days === 1) return "Played yesterday";
  if (days < 30) return `Played ${days} days ago`;
  return "Played " + fmtDate(i.lastPlayed);
}
const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : "" + n);
const accentFor = (hex) => `linear-gradient(135deg, ${hex}, ${hex}aa)`;

function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; }

// ---- Voxel formatting helpers (match the Mac app's strings exactly) ----

// "8h 52m" / "3h 30m" / "16s". Under a minute stays in seconds, because a
// brand-new instance reading "0m" looks broken next to one reading "8h 52m".
function fmtPlaytime(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
// "21m ago" / "8h ago" / "2d ago" / "Jul 7" once it stops being recent.
function relTime(ts) {
  if (!ts) return "Never played";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDate(ts);
}
// The recessed image well. Every one is a real drop target: with art it shows
// the art, without it invites you to drop one (matching Mac's InstanceArtwork).
function artBox(i, cls) {
  const url = i.iconPath ? `${fileURL(i.iconPath)}?v=${i.iconVersion || 0}` : null;
  const inner = url
    ? `<img src="${url}" alt="" class="art-img">`
    : `<div class="art-invite">${ico("i-image")}<span>Drop an image</span><span class="art-browse">or <u>browse files</u></span></div>`;
  return `<div class="imgbox ${cls || ""}" data-art="${i.id}" title="Drop an image, or click to browse">${inner}</div>`;
}
// Longest playtime in the list defines a full bar, so the bars compare against
// each other instead of against an arbitrary constant.
function playBar(ms, max) {
  const pct = max > 0 ? Math.max(2, Math.round((Number(ms) || 0) / max * 100)) : 0;
  return `<div class="dashbar"><i style="width:${pct}%"></i></div>`;
}

// ---------- HOME (Play) ----------
async function renderHome() {
  el().innerHTML = `<div class="placeholder">${ico("i-home")}<h2>Loading…</h2></div>`;
  const [instances, servers] = await Promise.all([
    API.instances(),
    API.servers.list().catch(() => []),
  ]);
  const recent = instances[0];

  if (!recent) {
    el().innerHTML = `
      <div class="placeholder">${ico("i-stack")}
        <h2>No instances yet</h2>
        <p>Create one to start playing.</p>
        <button class="play-btn" data-goto="instances">${ico("i-plus")} New Instance</button>
      </div>`;
    bindCommon();
    return;
  }

  const maxPlay = Math.max(...instances.map((i) => Number(i.playtimeMs) || 0), 1);
  const heroArt = recent.iconPath ? `${fileURL(recent.iconPath)}?v=${recent.iconVersion || 0}` : null;
  const jump = instances.slice(0, 6);

  el().innerHTML = `
    <section class="vhero${heroArt ? "" : " no-art"}" data-art="${recent.id}">
      ${heroArt ? `<div class="vhero-art" style="background-image:url('${heroArt}')"></div>`
                : `<div class="vhero-art vhero-art-empty">
                     <div class="art-invite">${ico("i-image")}<span>Drop a screenshot</span><span class="art-browse">or <u>browse files</u></span></div>
                   </div>`}
      <div class="vhero-scrim"></div>
      <div class="vhero-body">
        <div class="kick">Last played · ${esc(relTime(recent.lastPlayed))}</div>
        <h1 class="vhero-title">${esc(recent.name)}</h1>
        <div class="vhero-row">
          <div class="vchips">
            <span class="vchip">${esc(recent.mcVersion)}</span>
            <span class="vchip">${esc(loaderLabel(recent.loader))}</span>
            <span class="vchip">${recent.mods || 0} mod${recent.mods === 1 ? "" : "s"}</span>
            <span class="vchip">${esc(fmtPlaytime(recent.playtimeMs))} played</span>
          </div>
          <div class="vhero-actions">
            <button class="play-btn" data-play="${recent.id}">${ico("i-play")} Play</button>
            <button class="gh ico-btn" data-open="${recent.id}" title="Instance settings">${ico("i-sliders")}</button>
          </div>
        </div>
      </div>
    </section>

    <section class="vsec">
      <div class="vsec-head">
        <span class="kick">Jump back in</span>
        <button class="gh" data-goto="instances">All instances</button>
      </div>
      <div class="rail">
        ${jump.map((i) => `
          <button class="rcard" data-open="${i.id}">
            ${artBox(i, "rcard-art")}
            <div class="rcard-body">
              <div class="rcard-name">${esc(i.name)}</div>
              <div class="rcard-sub">${esc(relTime(i.lastPlayed))}</div>
              <div class="rcard-foot">
                ${playBar(i.playtimeMs, maxPlay)}
                <span class="rcard-time">${esc(fmtPlaytime(i.playtimeMs))}</span>
              </div>
            </div>
          </button>`).join("")}
      </div>
    </section>

    ${servers.length ? `
    <section class="vsec">
      <div class="vsec-head"><span class="kick">Servers</span></div>
      <div class="vserver-list">
        ${servers.slice(0, 4).map((s) => `
          <button class="vserver" data-server="${esc(s.id)}">
            <span class="vserver-ico">${ico("i-server")}</span>
            <span class="vserver-meta">
              <span class="vserver-name">${esc(s.name || "Minecraft Server")}</span>
              <span class="vserver-sub">${esc(s.instanceName || s.mcVersion || "")}</span>
            </span>
            <span class="vserver-dot${s.running ? " on" : ""}"></span>
          </button>`).join("")}
      </div>
    </section>` : ""}`;

  el().querySelectorAll("[data-server]").forEach((n) => n.onclick = () => renderServerDetail(n.dataset.server));
  bindArtDrops();
  bindCommon();
}

// Base64 a dropped file without spreading it through String.fromCharCode —
// a multi-megabyte screenshot would pass millions of arguments and overflow
// the call stack. FileReader hands us the encoding already done.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Couldn't read that image."));
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.readAsDataURL(file);
  });
}

// Wire every .imgbox (and the hero) as a click-to-browse + drag-to-drop art
// target. Mirrors the Mac PackArtPicker: a chosen image becomes the pack art.
function bindArtDrops() {
  el().querySelectorAll("[data-art]").forEach((node) => {
    const id = node.dataset.art;
    node.addEventListener("click", async (e) => {
      if (e.target.closest("[data-play],[data-del],.play-btn,.gh")) return;
      if (!node.classList.contains("imgbox") && !node.classList.contains("no-art")) return;
      e.stopPropagation();
      try { if (await API.icons.pick(id)) { toast("Art updated."); renderHome(); } }
      catch (err) { toast("Couldn't set art: " + err.message); }
    });
    node.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); node.classList.add("drop-on"); });
    node.addEventListener("dragleave", () => node.classList.remove("drop-on"));
    node.addEventListener("drop", async (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file || !/^image\//.test(file.type)) return;   // let pack files fall through to the window handler
      e.preventDefault(); e.stopPropagation();
      node.classList.remove("drop-on");
      try {
        const b64 = await fileToBase64(file);
        const ext = (file.name.split(".").pop() || "png").toLowerCase();
        await API.icons.set(id, b64, ext);
        toast("Art updated."); renderHome();
      } catch (err) { toast("Couldn't set art: " + err.message); }
    });
  });
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
      ${instances.map(instGridCard).join("") || `<div class="empty-line">No instances yet. Hit <b>New Instance</b>, <b>Import</b> a .mrpack or .lodepack, or drag a pack file anywhere in this window.</div>`}
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

    <!-- [Cloud Sync — Vertical A] filled async by renderInstanceCloudSync; hidden when the backend isn't set up. -->
    <div id="cloud-sync-panel"></div>

    <!-- [Crash Doctor] filled async by renderInstanceDoctor; slim when the last session was clean. -->
    <div id="doctor-panel"></div>

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
  detailInstForSync = inst;                 // [Cloud Sync] so live cloud:sync events can refresh the panel
  renderInstanceCloudSync(inst);            // fills #cloud-sync-panel (async; no-op when unconfigured)
  renderInstanceDoctor(inst);               // [Crash Doctor] fills #doctor-panel (async)
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
    // [wave0] trash-tier delete: worlds go to the Recycle Bin (Mac parity)
    if (!confirm(`Move "${world}" to the Recycle Bin?`)) return;
    try { const r = await API.worlds.remove({ instanceId: id, world }); toast(r && r.trashed ? "World moved to the Recycle Bin." : "World deleted."); renderInstanceDetail(id); }
    catch (err) { toast("Delete failed: " + err.message); }
    // [/wave0]
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
    toast(ok ? "Share code copied to the clipboard." : "Couldn't copy. Select the code and copy it by hand.");
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
      <button class="btn-ghost world-x" data-wdelete="${esc(w.name)}" title="Move to Recycle Bin">${ico("i-trash")}</button><!-- [wave0] trash-tier copy -->
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

// [wave0] Version-channel toggles for the create-instance flow. Off by default →
// releases only (unchanged). Ticking a box refetches with that channel and folds
// its ids into the picker, newest-channel-first, still capped for length.
let npSnapshots = false, npOldVersions = false;
function npVersionOptions(v) {
  let ids = (v.releases || []).slice(0, 60);
  if (npSnapshots && v.snapshots) ids = v.snapshots.slice(0, 40).concat(ids);
  if (npOldVersions) ids = ids.concat((v.old_beta || []), (v.old_alpha || []));
  return ids.map((r) => `<option>${esc(r)}</option>`).join("");
}
async function toggleNewPanel() {
  const panel = document.getElementById("new-panel");
  if (!creating) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="glass new-panel"><div class="np-row"><span>Loading versions…</span></div></div>`;
  const channels = [];                       // [wave0]
  if (npSnapshots) channels.push("snapshot");
  if (npOldVersions) channels.push("old_beta", "old_alpha");
  const v = await API.versions(channels.length ? { channels } : undefined);
  const loaders = ["vanilla", "fabric", "quilt", "neoforge", "forge"];
  panel.innerHTML = `
    <div class="glass new-panel">
      <div class="np-grid">
        <label>NAME<input id="np-name" placeholder="My Instance" /></label>
        <label>LOADER
          <div class="seg" id="np-loader">${loaders.map((l, i) => `<button data-l="${l}" class="${i === 0 ? "on" : ""}">${loaderLabel(l)}</button>`).join("")}</div>
        </label>
        <label>MINECRAFT VERSION
          <select id="np-version">${npVersionOptions(v)}</select>
        </label>
      </div>
      <!-- [wave0] snapshot / historical version toggles -->
      <div class="np-row np-channels" style="gap:18px;font-size:12px;opacity:.85">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="np-snapshots"${npSnapshots ? " checked" : ""}/> Show snapshots</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="np-old"${npOldVersions ? " checked" : ""}/> Show old versions</label>
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
  // [wave0] toggling a channel refetches + rerenders the panel
  panel.querySelector("#np-snapshots").onchange = (e) => { npSnapshots = e.target.checked; toggleNewPanel(); };
  panel.querySelector("#np-old").onchange = (e) => { npOldVersions = e.target.checked; toggleNewPanel(); };
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
      <button class="card-del" data-del="${i.id}" title="Delete instance">${ico("i-trash")}</button>
      <button class="card-play" data-play="${i.id}" title="Play ${esc(i.name)}">${ico("i-play")}</button>
    </div>
    <div class="inst-body">
      <div class="inst-name">${esc(i.name)}</div>
      <div class="inst-chips"><span class="chip">${loaderLabel(i.loader)}</span><span class="chip mono">${esc(i.mcVersion)}</span>${i.mods ? `<span class="chip">${i.mods} mod${i.mods === 1 ? "" : "s"}</span>` : ""}</div>
      <div class="inst-stats">${playedLabel(i)}</div>
    </div>
  </div>`;

const instCard = (i) => `
  <div class="glass inst-card" data-play="${i.id}" title="Play ${esc(i.name)}">
    <div class="inst-art" style="background:${accentFor(i.accent)}33">${ico("i-stack")}
      <span class="card-play sm" aria-hidden="true">${ico("i-play")}</span>
    </div>
    <div class="inst-body">
      <div class="inst-name">${esc(i.name)}</div>
      <div class="inst-chips"><span class="chip">${loaderLabel(i.loader)}</span><span class="chip mono">${esc(i.mcVersion)}</span></div>
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
  return `<div class="placeholder">${ico("i-compass")}<h2>${title}</h2><p>Not built yet. It arrives in a future update.</p></div>`;
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
  if (section === "discover") discoverTarget = null;   // Discover = browse for any instance
  ({ home: renderHome, instances: renderInstances, discover: renderDiscover, servers: renderServers, cloud: renderCloud, friends: renderFriends, squads: renderSquads, settings: renderSettings }[section] || (() => el().innerHTML = placeholder(section[0].toUpperCase() + section.slice(1))))();
}

// ---- PINNED sidebar block ----
// Shows instances you've pinned. Until you pin anything it falls back to your
// three most-played, so the block is useful on day one instead of empty — the
// same smart-default the Mac sidebar leans on.
async function renderPinned() {
  const host = document.getElementById("pinned-block");
  if (!host) return;
  let instances = [];
  try { instances = await API.instances(); } catch { return; }
  const explicit = instances.filter((i) => i.pinned);
  const list = (explicit.length ? explicit : [...instances]
    .sort((a, b) => (Number(b.playtimeMs) || 0) - (Number(a.playtimeMs) || 0))
    .filter((i) => Number(i.playtimeMs) > 0)
  ).slice(0, 4);

  if (!list.length) { host.innerHTML = ""; return; }
  host.innerHTML = `
    <div class="nav-group">Pinned</div>
    <div class="nav">
      ${list.map((i) => `
        <button class="pin-item" data-pin-open="${i.id}" title="${esc(i.name)}">
          <span class="pin-dot" style="background:${esc(i.accent || "#8EC44F")}"></span>
          <span class="pin-name">${esc(i.name)}</span>
        </button>`).join("")}
    </div>`;
  host.querySelectorAll("[data-pin-open]").forEach((b) => b.onclick = () => {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("is-active"));
    renderInstanceDetail(b.dataset.pinOpen);
  });
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
    // Voxel foot: the real skin head + name, then icon-only actions. No card,
    // no chevron, no "Signed in" subtitle — the Mac pass stripped all three.
    // There is deliberately no bell: nothing generates notifications yet, and
    // a bell that never lights up is decoration pretending to be a feature.
    node.innerHTML = `
      <img class="avatar" src="https://mc-heads.net/avatar/${esc(acc.uuid.replace(/-/g, ""))}/64" />
      <div class="account-meta"><div class="account-name">${esc(acc.name)}</div></div>
      <button class="account-act" id="acc-prefs" title="Preferences">${ico("i-sliders")}</button>
      <button class="account-act" id="acc-out" title="Sign out">${ico("i-user")}</button>`;
    document.getElementById("acc-prefs").onclick = () => navigate("settings");
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
          <p>The launcher works fully offline without this. To turn on accounts and the social features, connect a Supabase project once. It takes about two minutes.</p>
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
              ? `Linked to <b>${esc(p.minecraft_name || "your account")}</b> . Friends see this name and skin.`
              : `Link your Minecraft account so friends recognize you by your in-game name and skin.`}</p>
          </div>
          <button class="btn-soft" id="cloud-linkmc">${ico("i-link")} ${mcLinked ? "Relink" : "Link Minecraft"}</button>
        </div>
      </div>

      <!-- [Cloud Sync — Vertical A] instances synced from any of your machines. -->
      <div class="cloud-card glass">
        <div class="cloud-sync-head">
          <h2 class="cloud-h2">Synced from your other devices</h2>
          <button class="btn-ghost cloud-sync-refresh" id="cloud-sync-refresh">Refresh</button>
        </div>
        <p class="cloud-sub-inline">Instances you've pushed to the cloud from any machine. Pull one to rebuild it here: a matching local instance is reconciled, otherwise it's added as new.</p>
        <div id="cloud-sync-list"><div class="sync-loading"><span class="spinner"></span> Loading…</div></div>
      </div>

      <div class="cloud-card glass cloud-soon">
        <p><b>Friends &amp; chat</b> light up here as they ship. This account is what they run on.</p>
      </div>
    </div>`;

  renderCloudSyncList();                                   // [Cloud Sync] fill the synced-instances list
  document.getElementById("cloud-sync-refresh").onclick = () => renderCloudSyncList();
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

// ---------- Cloud Sync (Vertical A) ----------
// The per-instance "Cloud sync" control (instance detail) + the "Synced from your
// other devices" list (Account tab). Both live-refresh over the cloud:sync channel.
// The manifest pushed here IS the share-code payload, so a pull replays through the
// same install / update / remove reconcile that pasting a code would.
let detailInstForSync = null;   // instance whose detail is showing, for live panel refresh

function fmtWhen(v) {
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!t || Number.isNaN(t)) return "recently";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Instance-detail card. Hidden entirely when the backend isn't configured (the
// launcher is fully usable offline); otherwise shows signed-out / not-synced / synced.
async function renderInstanceCloudSync(inst) {
  const box = document.getElementById("cloud-sync-panel");
  if (!box) return;
  let st;
  try { st = await API.cloud.sync.status(inst.id); }
  catch { box.innerHTML = ""; return; }
  if (!box.isConnected) return;                 // navigated away while awaiting
  if (!st.configured) { box.innerHTML = ""; return; }

  const head = `<div class="section-head" style="margin-top:26px"><span class="section-title">CLOUD SYNC</span></div>`;

  if (!st.signedIn) {
    box.innerHTML = `${head}
      <div class="glass sync-panel">
        <div class="sync-info">
          <div class="sync-title">${ico("i-globe")} Cloud sync</div>
          <div class="sync-meta">Sign in to your Lodestone account to sync this instance across your machines.</div>
        </div>
        <div class="sync-actions"><button class="btn-soft" data-goto="cloud">Go to Account</button></div>
      </div>`;
    box.querySelectorAll("[data-goto]").forEach((n) => n.addEventListener("click", () => navigate(n.dataset.goto)));
    return;
  }

  const row = st.row;
  box.innerHTML = `${head}
    <div class="glass sync-panel">
      <div class="sync-info">
        <div class="sync-title">${ico("i-globe")} ${row ? "Synced to your account" : "Cloud sync"}</div>
        <div class="sync-meta">${row
          ? `Last pushed from <b>${esc(row.device || "a device")}</b> · ${esc(fmtWhen(row.updatedAt))} · ${row.modCount} mod${row.modCount === 1 ? "" : "s"}.`
          : "Push this instance's mod list to your account so you can rebuild it on any machine."}</div>
      </div>
      <div class="sync-actions">
        ${row ? `<button class="btn-ghost sync-remove">Remove from cloud</button>` : ""}
        <button class="btn-accent sync-push">${ico(row ? "i-download" : "i-globe")} ${row ? "Update cloud copy" : "Sync this instance to cloud"}</button>
      </div>
    </div>`;

  box.querySelector(".sync-push").onclick = async (e) => {
    const btn = e.currentTarget; const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Syncing…`;
    try {
      const r = await API.cloud.sync.push(inst.id);
      toast(`Synced ${inst.name} to the cloud (${r.modCount} mod${r.modCount === 1 ? "" : "s"}).`);
      renderInstanceCloudSync(inst);
    } catch (err) { btn.disabled = false; btn.innerHTML = original; toast("Couldn't sync: " + err.message); }
  };
  const rm = box.querySelector(".sync-remove");
  if (rm) rm.onclick = async () => {
    if (!confirm(`Remove "${inst.name}" from your cloud? Your local instance stays. Only the cloud copy is deleted.`)) return;
    rm.disabled = true;
    try { await API.cloud.sync.remove(row.id); toast("Removed from the cloud."); renderInstanceCloudSync(inst); }
    catch (err) { rm.disabled = false; toast("Couldn't remove: " + err.message); }
  };
}

// The "Synced from your other devices" list on the Account tab. Each row rebuilds
// from the cloud: reconcile the matching local instance, or add it as a new one.
async function renderCloudSyncList() {
  const box = document.getElementById("cloud-sync-list");
  if (!box) return;
  let rows = [], locals = [];
  try { rows = await API.cloud.sync.list(); } catch { rows = []; }
  try { locals = await API.instances(); } catch { locals = []; }
  if (!box.isConnected) return;
  const localIds = new Set(locals.map((i) => i.id));
  if (!rows.length) {
    box.innerHTML = `<div class="empty-line">Nothing synced yet. Open an instance and hit “Sync this instance to cloud”.</div>`;
    return;
  }
  box.innerHTML = rows.map((r) => {
    const here = localIds.has(r.clientInstanceId);
    const ver = r.loader && r.loader !== "vanilla"
      ? `${r.loader[0].toUpperCase()}${r.loader.slice(1)} ${r.mcVersion || ""}` : (r.mcVersion || "—");
    return `
    <div class="glass sync-row">
      <div class="sync-row-art">${ico("i-stack")}</div>
      <div class="sync-row-meta">
        <div class="sync-row-title">${esc(r.name)}${here ? `<span class="sync-tag">on this machine</span>` : ""}</div>
        <div class="sync-row-sub">${esc(ver)} · ${r.modCount} mod${r.modCount === 1 ? "" : "s"} · ${esc(r.device || "a device")} · ${esc(fmtWhen(r.updatedAt))}</div>
      </div>
      <div class="sync-row-actions">
        <button class="btn-${here ? "accent" : "soft"} sync-pull" data-pull="${esc(r.id)}">${ico(here ? "i-download" : "i-plus")} ${here ? "Sync to this machine" : "Add as new instance"}</button>
        <button class="btn-ghost sync-x" data-remove="${esc(r.id)}" title="Remove from cloud">${ico("i-trash")}</button>
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll("[data-pull]").forEach((b) => b.onclick = async () => {
    const original = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Working…`;
    try {
      const r = await API.cloud.sync.pull(b.dataset.pull);
      const parts = [];
      if (r.added) parts.push(`${r.added} added`);
      if (r.removed) parts.push(`${r.removed} removed`);
      const detail = parts.length ? ` (${parts.join(", ")})` : "";
      toast(r.mode === "created"
        ? `Added ${r.instanceName}${detail}.`
        : `Synced ${r.instanceName} to this machine${detail || " · already up to date"}.`);
      renderCloudSyncList();
    } catch (err) { b.disabled = false; b.innerHTML = original; toast("Couldn't pull: " + err.message); }
  });
  box.querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove this instance from your cloud? Local copies are untouched.")) return;
    b.disabled = true;
    try { await API.cloud.sync.remove(b.dataset.remove); toast("Removed from the cloud."); renderCloudSyncList(); }
    catch (err) { b.disabled = false; toast("Couldn't remove: " + err.message); }
  });
}

// Keep the Account view + nav badge honest as the session changes / refreshes.
function setupCloud() {
  API.on("cloud:auth", (s) => {
    cloudAuthState = s;
    const active = document.querySelector('.nav-item[data-section="cloud"].is-active');
    if (active) renderCloud();
    // A fresh sign-in / sign-out changes what squads + chat can see; refresh if open.
    if (document.getElementById("squads-root")) renderSquads();
  });
  // [Cloud Sync] live-refresh whatever's showing when a synced_instances row changes.
  API.on("cloud:sync", () => {
    if (document.getElementById("cloud-sync-list")) renderCloudSyncList();
    if (document.getElementById("cloud-sync-panel") && detailInstForSync) renderInstanceCloudSync(detailInstForSync);
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
            : "Connect a Supabase project once to turn on accounts and the social features. The launcher works fully offline without it."}</p>
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
    listEl.innerHTML = `<div class="friends-empty">No friends yet. Search above to add someone.</div>`;
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

// ---------- Squads + Chat (Vertical C) ----------
// A two-pane messenger on the Lodestone account: squad group channels down the
// left with DMs, a live chat pane on the right. Messages arrive over the
// "cloud:message" event (RLS-filtered to the user's channels) and are deduped by
// id so the optimistic echo on send never doubles up with the Realtime delivery.
let chatSubs = [];              // active "cloud:message" subscriptions
let chatActive = null;          // { type:'squad'|'dm', id, key, title, squad?, partner? }
let chatMsgs = [];              // messages in the open channel (shaped, chronological)
let chatMe = null;             // my profile (id + Minecraft skin for "me" rows)
let squadsCache = [];           // last-loaded squads (with rosters)
let dmsCache = [];              // last-loaded DM conversations
const chatUnread = new Set();   // channel keys with unseen messages while another is open
function clearChatSubs() { chatSubs.forEach((u) => { try { u(); } catch {} }); chatSubs = []; }

function chatName(p, isMe) {
  if (isMe) return "You";
  if (!p) return "Player";
  return p.display_name || p.username || p.minecraft_name || "Player";
}
function chatAvatar(p, cls) {
  const uuid = p && p.minecraft_uuid ? String(p.minecraft_uuid).replace(/-/g, "") : null;
  if (uuid) return `<img class="${cls}" src="https://mc-heads.net/avatar/${esc(uuid)}/64" alt="" />`;
  const src = p && (p.display_name || p.username || p.minecraft_name);
  return `<div class="${cls} ph">${esc(src ? src[0].toUpperCase() : "?")}</div>`;
}
function chatTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

async function renderSquads() {
  clearChatSubs();
  el().innerHTML = `<div class="placeholder">${ico("i-chat")}<h2>Loading…</h2></div>`;
  let status;
  try { status = await API.cloud.status(); }
  catch (e) { el().innerHTML = `<div class="placeholder">${ico("i-chat")}<h2>Squads</h2><p>${esc(e.message)}</p></div>`; return; }

  if (!status.configured) {
    el().innerHTML = `
      <div class="cloud-wrap">
        <div class="cloud-head"><h1>Squads</h1><p class="cloud-sub">Group up and chat in squads and direct messages.</p></div>
        <div class="cloud-card glass cloud-setup">${ico("i-chat")}
          <h2>Cloud backend not set up yet</h2>
          <p>Squads and chat run on a Lodestone account. Connect a Supabase project once to turn them on. The launcher works fully offline without it.</p>
          <p class="cloud-hint">See <b>SETUP.md</b> in the repo, then restart Lodestone.</p>
        </div>
      </div>`;
    return;
  }
  if (!status.signedIn) {
    el().innerHTML = `
      <div class="cloud-wrap">
        <div class="cloud-head"><h1>Squads</h1><p class="cloud-sub">Group up and chat in squads and direct messages.</p></div>
        <div class="cloud-card glass cloud-setup">${ico("i-chat")}
          <h2>Sign in to chat</h2>
          <p>Squads and messages live on your Lodestone account. Sign in to create a squad, invite friends, and start talking.</p>
          <button class="btn-accent" style="width:auto;padding:9px 20px" id="sq-go-account">Go to Account</button>
        </div>
      </div>`;
    document.getElementById("sq-go-account").onclick = () => navigate("cloud");
    return;
  }

  chatMe = status.profile || (await API.cloud.profile().catch(() => null));
  [squadsCache, dmsCache] = await Promise.all([
    API.cloud.chat.listSquads().catch(() => []),
    API.cloud.chat.listDMs().catch(() => []),
  ]);

  el().innerHTML = `
    <div class="page-head">
      <h1 class="page-title">Squads</h1>
      <div class="head-actions">
        <button class="btn-soft" id="sq-join">${ico("i-arrow-right")} Join</button>
        <button class="btn-soft" id="sq-new">${ico("i-plus")} New squad</button>
      </div>
    </div>
    <div class="chat-layout" id="squads-root">
      <aside class="chat-side glass">
        <div class="chat-side-sec">SQUADS</div>
        <div class="chat-side-list" id="squad-list">${squadListHTML()}</div>
        <div class="chat-side-sec">DIRECT MESSAGES<button class="chat-side-add" id="dm-new" title="New message">${ico("i-plus")}</button></div>
        <div class="chat-side-list" id="dm-list">${dmListHTML()}</div>
      </aside>
      <section class="chat-main glass" id="chat-main"></section>
    </div>`;

  document.getElementById("sq-new").onclick = openNewSquadModal;
  document.getElementById("sq-join").onclick = openJoinSquadModal;
  document.getElementById("dm-new").onclick = openNewDmModal;
  bindSideLists();

  // Re-open the last channel if it still exists, else show the empty state.
  if (chatActive && chatActive.type === "squad") {
    const s = squadsCache.find((x) => x.id === chatActive.id);
    if (s) chatActive.squad = s; else chatActive = null;
  }
  highlightActive();
  renderChatPane();

  chatSubs.push(API.on("cloud:message", onChatIncoming));
}

function squadListHTML() {
  if (!squadsCache.length) return `<div class="chat-side-empty">No squads yet. Create one or join with a code.</div>`;
  return squadsCache.map((s) => {
    const key = `squad:${s.id}`;
    const count = (s.members || []).length;
    return `<button class="chat-chan${key === (chatActive && chatActive.key) ? " on" : ""}${chatUnread.has(key) ? " has-unread" : ""}" data-chan="${esc(key)}" data-kind="squad" data-id="${esc(s.id)}">
      <div class="chan-glyph">${ico("i-chat")}</div>
      <div class="chan-meta"><div class="chan-name">${esc(s.name)}</div><div class="chan-sub">${count} member${count === 1 ? "" : "s"}${s.isOwner ? " · owner" : ""}</div></div>
      <span class="chan-unread"></span>
    </button>`;
  }).join("");
}
function dmListHTML() {
  if (!dmsCache.length) return `<div class="chat-side-empty">No messages yet. Hit + to start one.</div>`;
  return dmsCache.map((d) => {
    const key = `dm:${d.channelId}`;
    return `<button class="chat-chan${key === (chatActive && chatActive.key) ? " on" : ""}${chatUnread.has(key) ? " has-unread" : ""}" data-chan="${esc(key)}" data-kind="dm" data-id="${esc(d.channelId)}">
      ${chatAvatar(d.partner, "chan-avatar")}
      <div class="chan-meta"><div class="chan-name">${esc(chatName(d.partner, false))}</div><div class="chan-sub">${esc(d.lastBody || "")}</div></div>
      <span class="chan-unread"></span>
    </button>`;
  }).join("");
}

function bindSideLists() {
  document.querySelectorAll(".chat-chan").forEach((b) => b.onclick = () => {
    if (b.dataset.kind === "squad") {
      const s = squadsCache.find((x) => x.id === b.dataset.id);
      if (s) openSquadChannel(s);
    } else {
      const d = dmsCache.find((x) => x.channelId === b.dataset.id);
      if (d) openDmChannel(d);
    }
  });
}
function highlightActive() {
  document.querySelectorAll(".chat-chan").forEach((b) => b.classList.toggle("on", chatActive && b.dataset.chan === chatActive.key));
}

function openSquadChannel(s) { chatActive = { type: "squad", id: s.id, key: `squad:${s.id}`, title: s.name, squad: s }; afterOpen(); }
function openDmChannel(d) { chatActive = { type: "dm", id: d.channelId, key: `dm:${d.channelId}`, title: chatName(d.partner, false), partner: d.partner }; afterOpen(); }
function afterOpen() {
  chatUnread.delete(chatActive.key);
  const item = document.querySelector(`.chat-chan[data-chan="${chatActive.key}"]`);
  if (item) item.classList.remove("has-unread");
  highlightActive();
  renderChatPane();
}

async function renderChatPane() {
  const main = document.getElementById("chat-main");
  if (!main) return;
  if (!chatActive) { main.innerHTML = `<div class="chat-empty">${ico("i-chat")}<h2>Pick a channel</h2><p>Choose a squad or start a direct message to begin chatting.</p></div>`; return; }

  main.innerHTML = `
    ${chatHeaderHTML()}
    <div class="chat-log" id="chat-log"><div class="chat-loading"><span class="spinner"></span></div></div>
    <div class="chat-compose">
      <input id="chat-input" placeholder="Message ${esc(chatActive.title)}…" autocomplete="off" />
      <button class="btn-accent chat-send" id="chat-send">${ico("i-arrow-right")}</button>
    </div>`;

  // Header actions (squad only): invite + leave/delete.
  if (chatActive.type === "squad") {
    const s = chatActive.squad || {};
    const inv = document.getElementById("sq-invite"); if (inv) inv.onclick = () => openSquadInviteModal(s);
    const lv = document.getElementById("sq-leave"); if (lv) lv.onclick = () => leaveSquadFlow(s);
  }

  const input = document.getElementById("chat-input");
  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      const m = await API.cloud.chat.send({ channelType: chatActive.type, channelId: chatActive.id, body: text });
      appendChatMessage(m);
      bumpChannelPreview(m);
    } catch (e) { input.value = text; toast("Couldn't send: " + e.message); }
  };
  document.getElementById("chat-send").onclick = doSend;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSend(); } });
  input.focus();

  try {
    chatMsgs = await API.cloud.chat.history({ channelType: chatActive.type, channelId: chatActive.id, limit: 200 });
  } catch (e) {
    const log = document.getElementById("chat-log");
    if (log) log.innerHTML = `<div class="empty-line">Couldn't load messages: ${esc(e.message)}</div>`;
    return;
  }
  renderLog();
}

function chatHeaderHTML() {
  if (chatActive.type === "squad") {
    const s = chatActive.squad || {};
    const members = s.members || [];
    const roster = members.slice(0, 6).map((m) => chatAvatar(m, "roster-avatar")).join("");
    const extra = members.length > 6 ? `<span class="roster-more">+${members.length - 6}</span>` : "";
    return `<div class="chat-head">
      <div class="chat-head-main">
        <div class="chat-title">${esc(s.name || "Squad")}</div>
        <div class="chat-roster">${roster}${extra}<span class="chat-roster-count">${members.length} member${members.length === 1 ? "" : "s"}</span></div>
      </div>
      <div class="chat-head-actions">
        <button class="btn-soft" id="sq-invite">${ico("i-link")} Invite</button>
        <button class="btn-ghost" id="sq-leave">${s.isOwner ? "Delete" : "Leave"}</button>
      </div>
    </div>`;
  }
  const p = chatActive.partner || {};
  return `<div class="chat-head">
    <div class="chat-head-main dm">${chatAvatar(p, "chat-head-avatar")}
      <div><div class="chat-title">${esc(chatName(p, false))}</div><div class="chat-sub2">Direct message</div></div>
    </div>
  </div>`;
}

function chatLogHTML() {
  if (!chatMsgs.length) return `<div class="chat-empty-log">No messages yet. Say hello.</div>`;
  const meId = chatMe && chatMe.id;
  let html = ""; let prev = null;
  for (const m of chatMsgs) {
    const isMe = m.sender === meId;
    const grouped = prev && prev.sender === m.sender && (new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60 * 1000);
    html += `
      <div class="chat-msg${isMe ? " me" : ""}${grouped ? " grouped" : ""}">
        <div class="chat-msg-gutter">${grouped ? "" : chatAvatar(m.senderProfile, "chat-avatar")}</div>
        <div class="chat-msg-body">
          ${grouped ? "" : `<div class="chat-msg-head"><span class="chat-msg-name">${esc(chatName(m.senderProfile, isMe))}</span><span class="chat-msg-time">${esc(chatTime(m.createdAt))}</span></div>`}
          <div class="chat-msg-text">${esc(m.body)}</div>
        </div>
      </div>`;
    prev = m;
  }
  return html;
}
function renderLog() {
  const log = document.getElementById("chat-log");
  if (!log) return;
  log.innerHTML = chatLogHTML();
  log.scrollTop = log.scrollHeight;
}
function appendChatMessage(m) {
  if (chatMsgs.some((x) => String(x.id) === String(m.id))) return;   // dedupe echo vs realtime
  chatMsgs.push(m);
  renderLog();
}

// Freshen a channel's side-list preview + reorder DMs newest-first.
function bumpChannelPreview(m) {
  if (m.channelType === "dm") {
    const d = dmsCache.find((x) => x.channelId === m.channelId);
    if (d) { d.lastBody = m.body; d.lastAt = m.createdAt; dmsCache.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)); }
    const dl = document.getElementById("dm-list"); if (dl) { dl.innerHTML = dmListHTML(); }
  }
  bindSideLists(); highlightActive();
}

function onChatIncoming(m) {
  if (!document.getElementById("squads-root")) return;   // not on the Squads tab; reloads on return
  if (chatActive && m.channelType === chatActive.type && m.channelId === chatActive.id) {
    appendChatMessage(m);
    bumpChannelPreview(m);
    return;
  }
  const key = `${m.channelType}:${m.channelId}`;
  const item = document.querySelector(`.chat-chan[data-chan="${key}"]`);
  if (item) { chatUnread.add(key); item.classList.add("has-unread"); bumpChannelPreview(m); }
  else { refreshLists(); }   // a channel we didn't know about (new DM) — pull it in
}

async function refreshLists() {
  const [squads, dms] = await Promise.all([
    API.cloud.chat.listSquads().catch(() => squadsCache),
    API.cloud.chat.listDMs().catch(() => dmsCache),
  ]);
  squadsCache = squads; dmsCache = dms;
  const sl = document.getElementById("squad-list"); if (sl) sl.innerHTML = squadListHTML();
  const dl = document.getElementById("dm-list"); if (dl) dl.innerHTML = dmListHTML();
  bindSideLists(); highlightActive();
  if (chatActive && chatActive.type === "squad") {
    const s = squadsCache.find((x) => x.id === chatActive.id);
    if (s) chatActive.squad = s;
  }
}

// ---- Squad + DM modals ----
function openNewSquadModal() {
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-chat")} New squad</div>
      <p class="share-sub">Create a group channel. You'll get an invite code to bring friends in.</p>
      <input id="nsq-name" class="chat-modal-input" placeholder="Squad name" maxlength="80" />
      <div class="cloud-err" id="nsq-err" hidden></div>
      <div class="np-actions">
        <button class="btn-ghost" id="nsq-cancel">Cancel</button>
        <button class="btn-accent share-btn" id="nsq-create">${ico("i-plus")} Create squad</button>
      </div>
    </div>`);
  const nameEl = document.getElementById("nsq-name"); nameEl.focus();
  document.getElementById("nsq-cancel").onclick = hideModal;
  const create = async () => {
    const name = nameEl.value.trim();
    const err = document.getElementById("nsq-err"); err.hidden = true;
    if (!name) { err.textContent = "Give your squad a name."; err.hidden = false; return; }
    const btn = document.getElementById("nsq-create"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Creating…`;
    try {
      const squad = await API.cloud.chat.createSquad({ name });
      hideModal(); toast(`Created ${squad.name}.`);
      await refreshLists();
      const s = squadsCache.find((x) => x.id === squad.id) || squad;
      openSquadChannel(s);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.innerHTML = `${ico("i-plus")} Create squad`;
    }
  };
  document.getElementById("nsq-create").onclick = create;
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
}

function openJoinSquadModal() {
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-arrow-right")} Join a squad</div>
      <p class="share-sub">Paste the invite code a friend shared with you.</p>
      <input id="jsq-code" class="chat-modal-input mono" placeholder="Invite code" spellcheck="false" />
      <div class="cloud-err" id="jsq-err" hidden></div>
      <div class="np-actions">
        <button class="btn-ghost" id="jsq-cancel">Cancel</button>
        <button class="btn-accent share-btn" id="jsq-join">${ico("i-arrow-right")} Join squad</button>
      </div>
    </div>`);
  const codeEl = document.getElementById("jsq-code"); codeEl.focus();
  document.getElementById("jsq-cancel").onclick = hideModal;
  const join = async () => {
    const inviteCode = codeEl.value.trim();
    const err = document.getElementById("jsq-err"); err.hidden = true;
    if (!inviteCode) { err.textContent = "Paste an invite code."; err.hidden = false; return; }
    const btn = document.getElementById("jsq-join"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Joining…`;
    try {
      const squad = await API.cloud.chat.joinSquad({ inviteCode });
      hideModal(); toast(`Joined ${squad.name}.`);
      await refreshLists();
      const s = squadsCache.find((x) => x.id === squad.id) || squad;
      openSquadChannel(s);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.innerHTML = `${ico("i-arrow-right")} Join squad`;
    }
  };
  document.getElementById("jsq-join").onclick = join;
  codeEl.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
}

function openSquadInviteModal(s) {
  const code = s.invite_code || "";
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-link")} Invite to ${esc(s.name)}</div>
      <p class="share-sub">Share this code. Anyone who enters it under <b>Join</b> becomes a member.</p>
      <div class="share-label">INVITE CODE</div>
      <textarea id="inv-code" class="share-box mono" readonly rows="1">${esc(code)}</textarea>
      <div class="np-actions">
        <button class="btn-ghost" id="inv-close">Close</button>
        <button class="btn-accent share-btn" id="inv-copy">${ico("i-download")} Copy code</button>
      </div>
    </div>`);
  document.getElementById("inv-close").onclick = hideModal;
  document.getElementById("inv-copy").onclick = async () => {
    const ok = await copyText(code, document.getElementById("inv-code"));
    toast(ok ? "Invite code copied." : "Couldn't copy. Select the code and copy it by hand.");
  };
}

async function leaveSquadFlow(s) {
  const owner = !!s.isOwner;
  if (!confirm(owner ? `Delete "${s.name}" for everyone? This removes the squad and its chat.` : `Leave "${s.name}"?`)) return;
  try {
    await API.cloud.chat.leaveSquad(s.id);
    toast(owner ? "Squad deleted." : `Left ${s.name}.`);
    if (chatActive && chatActive.key === `squad:${s.id}`) chatActive = null;
    await refreshLists();
    renderChatPane();
  } catch (e) { toast("Couldn't leave: " + e.message); }
}

function openNewDmModal() {
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-user")} New message</div>
      <p class="share-sub">Find someone by username, display name, or Minecraft name.</p>
      <div class="searchbar glass">${ico("i-search")}<input id="dm-search" placeholder="Search people…" autocomplete="off" spellcheck="false" /></div>
      <div id="dm-results" class="dm-results"><div class="empty-line">Type at least two characters.</div></div>
      <div class="np-actions"><button class="btn-ghost" id="dm-close">Close</button></div>
    </div>`);
  document.getElementById("dm-close").onclick = hideModal;
  const search = document.getElementById("dm-search"); search.focus();
  let timer = null;
  const run = async () => {
    const box = document.getElementById("dm-results");
    const q = search.value.trim();
    if (q.length < 2) { box.innerHTML = `<div class="empty-line">Type at least two characters.</div>`; return; }
    box.innerHTML = `<div class="empty-line">Searching…</div>`;
    let hits = [];
    try { hits = await API.cloud.searchProfiles(q); }
    catch (e) { box.innerHTML = `<div class="empty-line">Search failed: ${esc(e.message)}</div>`; return; }
    if (!hits.length) { box.innerHTML = `<div class="empty-line">No one found.</div>`; return; }
    box.innerHTML = hits.map((p) => `
      <button class="dm-result" data-id="${esc(p.id)}">
        ${chatAvatar(p, "chan-avatar")}
        <div class="chan-meta"><div class="chan-name">${esc(chatName(p, false))}</div><div class="chan-sub">@${esc(p.username || "player")}${p.minecraft_name ? " · " + esc(p.minecraft_name) : ""}</div></div>
      </button>`).join("");
    box.querySelectorAll(".dm-result").forEach((b) => b.onclick = async () => {
      const person = hits.find((x) => x.id === b.dataset.id);
      try {
        const { channelId, partner } = await API.cloud.chat.startDm(b.dataset.id);
        hideModal();
        let d = dmsCache.find((x) => x.channelId === channelId);
        if (!d) { d = { channelId, partner: partner || person, lastBody: "", lastAt: new Date().toISOString() }; dmsCache.unshift(d); }
        const dl = document.getElementById("dm-list"); if (dl) dl.innerHTML = dmListHTML();
        bindSideLists();
        openDmChannel(d);
      } catch (e) { toast("Couldn't start chat: " + e.message); }
    });
  };
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 260); });
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
    if (ph) ph.textContent = `${phaseLabel[p.phase] || p.phase} · ${p.done}/${p.total}`;
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
renderPinned();
setupLaunchOverlay();
setupUpdates();
setupCloud();
setupFriends();
setupCommandPalette();
navigate("home");

// The pinned block is derived from instance state (pins + playtime), so it has
// to refresh whenever a session ends or an instance is created/removed rather
// than only at boot.
if (window.API && API.on) { try { API.on("launch:state", (s) => { if (s && s.status === "idle") { renderPinned(); } }); } catch { /* non-desktop build */ } }

// ========================================================================
// [Crash Doctor] — diagnosis cards + the mod bisect flow (instance detail).
// Scan reads the newest crash report + latest.log tail through the engine and
// shows ranked causes with one-click fixes wired to real actions; the bisect
// drives the engine's persistent binary search over the enabled mods.
// ========================================================================
let doctorLastScan = null;   // latest scan for the open detail page (fix lookup by index)

const doctorConfChip = (c) => `<span class="doctor-conf ${esc(c)}">${esc(c)}</span>`;

function doctorFixLabel(fix) {
  if (!fix) return "Apply fix";
  return {
    ram: "Raise RAM", repair: "Run Repair", clearJavaOverride: "Clear Java override",
    disableMod: "Disable mod", enableMod: "Re-enable mod", removeMod: "Remove mod",
    installDep: "Install dependency", updateMod: "Update mod",
  }[fix.type] || "Apply fix";
}

function doctorDiagCard(d, i) {
  const mods = (d.mods || []).filter((m) => m && m.title);
  const bisectable = !d.autoFixable && ["mixin-conflict", "mod-crash", "world-crash", "unknown"].includes(d.cause);
  return `
  <div class="glass doctor-card">
    <div class="doctor-card-head">
      <div class="doctor-card-title">${ico("i-pulse")} ${esc(d.title)}</div>
      ${doctorConfChip(d.confidence)}
    </div>
    ${d.evidence ? `<pre class="doctor-evidence">${esc(d.evidence)}</pre>` : ""}
    <div class="doctor-fix-text">${esc(d.suggestedFix)}</div>
    ${mods.length ? `<div class="doctor-mods">${mods.map((m) => `<span class="doctor-mod-chip" title="${esc(m.fileName || "")}">${esc(m.title)}</span>`).join("")}</div>` : ""}
    <div class="doctor-card-actions">
      ${d.autoFixable && d.fix ? `<button class="btn-accent doctor-apply" data-dfix="${i}">${ico("i-bolt")} ${esc(doctorFixLabel(d.fix))}</button>` : ""}
      ${bisectable ? `<button class="btn-soft doctor-bisect-cta">${ico("i-search")} Start mod bisect</button>` : ""}
    </div>
  </div>`;
}

function doctorBisectCard(st) {
  if (st.status === "active") {
    const done = Math.max(0, st.totalMods - st.suspectCount);
    const pct = st.totalMods > 1 ? Math.round((done / (st.totalMods - 1)) * 100) : 0;
    const disabledList = (st.disabled || []).map((f) => esc(f.replace(/\.disabled$/i, ""))).join("\n");
    return `
    <div class="glass doctor-card doctor-bisect">
      <div class="doctor-card-head">
        <div class="doctor-card-title">${ico("i-search")} Mod bisect · round ${st.round}</div>
        <span class="doctor-conf medium">${st.suspectCount} suspected</span>
      </div>
      <div class="doctor-fix-text">Round ${st.round} · ${st.suspectCount} mod${st.suspectCount === 1 ? "" : "s"} suspected ·
        ${st.disabledCount} disabled for this test · about ${st.roundsLeft} launch${st.roundsLeft === 1 ? "" : "es"} to go.</div>
      <div class="bar doctor-bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      ${st.disabledCount ? `<details class="doctor-disabled"><summary>${st.disabledCount} mod${st.disabledCount === 1 ? "" : "s"} disabled this round</summary><pre class="doctor-evidence">${disabledList}</pre></details>` : ""}
      <div class="doctor-fix-text">Launch the instance, see whether it crashes, then report the result.</div>
      <div class="doctor-card-actions">
        <button class="btn-accent" data-play="${esc(doctorLastScan ? doctorLastScan.instanceId : "")}">${ico("i-play")} Play to test</button>
        <button class="btn-soft doctor-crashed">It crashed</button>
        <button class="btn-soft doctor-clean">It ran fine</button>
        <button class="btn-ghost doctor-abort">Abort + restore all</button>
      </div>
    </div>`;
  }
  // done
  if (st.culprit) {
    const name = st.culprit.title && st.culprit.title !== st.culprit.fileName
      ? `${esc(st.culprit.title)} <span class="hit-author">${esc(st.culprit.fileName || "")}</span>`
      : esc(st.culprit.fileName || st.culprit.title || "unknown");
    return `
    <div class="glass doctor-card doctor-bisect">
      <div class="doctor-card-head">
        <div class="doctor-card-title">${ico("i-search")} Culprit isolated</div>
        <span class="doctor-conf high">done</span>
      </div>
      <div class="doctor-fix-text">The bisect pinned the crash on <b>${name}</b> after ${st.round} round${st.round === 1 ? "" : "s"}.
        Everything else is re-enabled; the culprit is parked as <span class="doctor-mono">.jar.disabled</span>.
        Play once more to confirm the crash is gone.</div>
      <div class="doctor-card-actions">
        <button class="btn-accent doctor-remove-culprit">${ico("i-trash")} Remove it</button>
        <button class="btn-soft doctor-keep-disabled">Keep disabled &amp; dismiss</button>
        <button class="btn-ghost doctor-restore-culprit">Re-enable everything</button>
      </div>
    </div>`;
  }
  return `
  <div class="glass doctor-card doctor-bisect">
    <div class="doctor-card-head">
      <div class="doctor-card-title">${ico("i-search")} Bisect finished</div>
      <span class="doctor-conf low">inconclusive</span>
    </div>
    <div class="doctor-fix-text">${esc(st.message || "The hunt ended without a single culprit.")} All mods have been re-enabled.</div>
    <div class="doctor-card-actions"><button class="btn-ghost doctor-keep-disabled">Dismiss</button></div>
  </div>`;
}

async function renderInstanceDoctor(inst) {
  const box = document.getElementById("doctor-panel");
  if (!box) return;
  let scan = null, bisect = null;
  try { [scan, bisect] = await Promise.all([API.doctor.scan(inst.id), API.doctor.bisect.status(inst.id)]); }
  catch { box.innerHTML = ""; return; }
  if (!box.isConnected) return;                 // navigated away while awaiting
  doctorLastScan = { instanceId: inst.id, scan };

  const head = `<div class="section-head" style="margin-top:26px"><span class="section-title">CRASH DOCTOR</span>
    <span class="section-action" id="doctor-rescan">Rescan</span></div>`;

  const meta = scan.crashReport
    ? `<div class="doctor-meta">${ico("i-pulse")} Newest crash report: <b>${esc(scan.crashReport.name)}</b> · ${esc(fmtDate(scan.crashReport.modified))}${scan.exception ? ` · <span class="doctor-mono">${esc(scan.exception.length > 90 ? scan.exception.slice(0, 90) + "…" : scan.exception)}</span>` : ""}</div>`
    : "";

  const showBisect = bisect && bisect.status && bisect.status !== "none";
  let body;
  if (!showBisect && !scan.diagnoses.length) {
    body = `
    <div class="glass doctor-card doctor-clean-state">
      <div class="doctor-card-head">
        <div class="doctor-card-title">${ico("i-pulse")} No crashes detected</div>
        <span class="doctor-conf high">healthy</span>
      </div>
      <div class="doctor-fix-text">${scan.crashReport
        ? "The newest crash report matched no active problem. The current setup looks clean."
        : "No crash reports found for this instance."}
        ${scan.enabledMods >= 2 ? " If the game is still misbehaving, a mod bisect can hunt the culprit by halves." : ""}</div>
      ${scan.enabledMods >= 2 ? `<div class="doctor-card-actions"><button class="btn-soft doctor-bisect-cta">${ico("i-search")} Start mod bisect</button></div>` : ""}
    </div>`;
  } else {
    body = `${showBisect ? doctorBisectCard(bisect) : ""}
      ${showBisect && bisect.status === "active" ? "" : scan.diagnoses.map((d, i) => doctorDiagCard(d, i)).join("")}`;
  }
  box.innerHTML = `${head}${meta}${body}`;

  // ---- handlers ----
  const rescan = box.querySelector("#doctor-rescan");
  if (rescan) rescan.onclick = () => renderInstanceDoctor(inst);

  box.querySelectorAll("[data-play]").forEach((n) => n.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { const r = await API.launch(inst.id); if (!r.started) toast(r.message || ""); }
    catch (err) { toast("Launch failed: " + err.message); }
  }));

  box.querySelectorAll(".doctor-apply").forEach((b) => b.onclick = async () => {
    const d = scan.diagnoses[Number(b.dataset.dfix)];
    if (!d || !d.fix) return;
    const original = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Working…`;
    try {
      const r = await API.doctor.fix(inst.id, d.fix);
      toast(r.message || "Fix applied.");
      renderInstanceDetail(inst.id);            // content / settings may have changed — full refresh
    } catch (err) { b.disabled = false; b.innerHTML = original; toast("Couldn't apply the fix: " + err.message); }
  });

  box.querySelectorAll(".doctor-bisect-cta").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const st = await API.doctor.bisect.start(inst.id);
      toast(`Bisect started: ${st.disabledCount} of ${st.totalMods} mods disabled for round 1.`);
      renderInstanceDoctor(inst);
    } catch (err) { b.disabled = false; toast("Couldn't start the bisect: " + err.message); }
  });

  const report = async (crashed) => {
    try {
      const st = await API.doctor.bisect.report(inst.id, crashed);
      if (st.status === "done") toast(st.culprit ? `Culprit isolated: ${st.culprit.title || st.culprit.fileName}.` : "Bisect finished.");
      else toast(`Round ${st.round}: ${st.suspectCount} mods still suspected.`);
      renderInstanceDoctor(inst);
    } catch (err) { toast("Couldn't record the round: " + err.message); }
  };
  const crashedBtn = box.querySelector(".doctor-crashed");
  if (crashedBtn) crashedBtn.onclick = () => report(true);
  const cleanBtn = box.querySelector(".doctor-clean");
  if (cleanBtn) cleanBtn.onclick = () => report(false);

  const abortBtn = box.querySelector(".doctor-abort");
  if (abortBtn) abortBtn.onclick = async () => {
    if (!confirm("Abort the bisect and re-enable every mod it disabled?")) return;
    abortBtn.disabled = true;
    try { await API.doctor.bisect.abort(inst.id, true); toast("Bisect aborted. All mods restored."); renderInstanceDoctor(inst); }
    catch (err) { abortBtn.disabled = false; toast("Couldn't abort: " + err.message); }
  };

  const removeCulprit = box.querySelector(".doctor-remove-culprit");
  if (removeCulprit) removeCulprit.onclick = async () => {
    const c = bisect.culprit || {};
    if (!confirm(`Remove ${c.title || c.fileName} from this instance permanently?`)) return;
    removeCulprit.disabled = true;
    try {
      await API.doctor.fix(inst.id, { type: "removeMod", projectId: c.projectId || null, fileName: c.fileName });
      await API.doctor.bisect.abort(inst.id, false);    // forget the session; nothing left to restore
      toast(`${c.title || c.fileName} removed.`);
      renderInstanceDetail(inst.id);
    } catch (err) { removeCulprit.disabled = false; toast("Couldn't remove it: " + err.message); }
  };
  const keepDisabled = box.querySelector(".doctor-keep-disabled");
  if (keepDisabled) keepDisabled.onclick = async () => {
    try { await API.doctor.bisect.abort(inst.id, false); toast("Dismissed. The culprit stays disabled."); renderInstanceDoctor(inst); }
    catch (err) { toast("Couldn't dismiss: " + err.message); }
  };
  const restoreCulprit = box.querySelector(".doctor-restore-culprit");
  if (restoreCulprit) restoreCulprit.onclick = async () => {
    restoreCulprit.disabled = true;
    try { await API.doctor.bisect.abort(inst.id, true); toast("All mods re-enabled."); renderInstanceDoctor(inst); }
    catch (err) { restoreCulprit.disabled = false; toast("Couldn't restore: " + err.message); }
  };
}

// ============================================================================
// [Content managers vertical] Resource packs / shader packs / datapacks (per
// world) + the keybinds manager, as new sections on the instance detail page.
// The shared renderInstanceDetail stays untouched: it's wrapped here, and these
// sections render into their own #packs-root appended after the core page —
// union-merge friendly with the other verticals.
// ============================================================================
let packsWorldSel = {};   // instanceId -> selected world for the datapacks card

const _renderInstanceDetailCore = renderInstanceDetail;
renderInstanceDetail = async function (id) {
  await _renderInstanceDetailCore(id);
  try { await renderPacksSections(id); } catch (e) { console.error("packs sections:", e); }
};

const packTitle = (p) => p.fileName.replace(/\.zip$/i, "");
function packSubline(p) {
  if (p.malformed) return `⚠ Unreadable pack.mcmeta, showing the file only`;
  const bits = [];
  if (p.description) bits.push(esc(p.description));
  else if (p.missingMeta) bits.push("No pack.mcmeta at the zip root");
  if (p.packFormat != null) bits.push(`format ${p.packFormat}`);
  if (p.isDir) bits.push("folder pack"); else if (p.size) bits.push(esc(fmtSize(p.size)));
  return bits.join(" · ") || esc(p.fileName);
}
const packIconHtml = (p) =>
  p.icon ? `<img class="hit-icon pack-icon" src="${esc(p.icon)}" />` : `<div class="hit-icon ph">${ico("i-grid")}</div>`;

async function renderPacksSections(id) {
  const host = el();
  if (!host || !host.querySelector(".detail-hero")) return;   // not on a detail page anymore

  const [rp, sh, pkWorlds, kb] = await Promise.all([
    API.packs.resourcePacks(id).catch((e) => ({ hasOptions: false, packs: [], enabledOrder: [], error: e.message })),
    API.packs.shaders(id).catch((e) => ({ packs: [], configFile: null, canSelect: false, selected: null, shadersOn: false, error: e.message })),
    API.worlds.list(id).catch(() => []),
    API.keybinds.list(id).catch((e) => ({ hasOptions: false, binds: [], categories: [], error: e.message })),
  ]);
  if (!host.isConnected || !host.querySelector(".detail-hero")) return;   // navigated away while loading

  // Datapacks are per world: pick the remembered world when it still exists.
  let selWorld = packsWorldSel[id];
  if (!pkWorlds.some((w) => w.name === selWorld)) selWorld = pkWorlds.length ? pkWorlds[0].name : null;
  packsWorldSel[id] = selWorld;
  let dp = { packs: [] };
  if (selWorld) dp = await API.packs.datapacks({ instanceId: id, world: selWorld }).catch(() => ({ packs: [] }));
  if (!host.isConnected || !host.querySelector(".detail-hero")) return;

  let root = document.getElementById("packs-root");
  if (!root) { root = document.createElement("div"); root.id = "packs-root"; host.appendChild(root); }

  // ---- Resource packs (display: highest priority first, then disabled A→Z) ----
  const dispOrder = (rp.enabledOrder || []).slice().reverse();
  const enabledRows = dispOrder
    .map((name) => rp.packs.find((p) => p.fileName === name))
    .filter(Boolean);
  const disabledRows = rp.packs.filter((p) => !p.enabled);

  const rpRow = (p, dispIdx) => `
    <div class="glass pack-row${p.enabled ? " on" : ""}">
      ${packIconHtml(p)}
      <div class="hit-meta">
        <div class="hit-title">${esc(packTitle(p))}${p.enabled ? `<span class="pack-pill">#${dispIdx + 1}</span>` : ""}</div>
        <div class="hit-desc">${packSubline(p)}</div>
      </div>
      <div class="pack-actions">
        ${p.enabled ? `
          <button class="btn-ghost pack-arrow" data-rp-up="${esc(p.fileName)}" title="Higher priority" ${dispIdx === 0 ? "disabled" : ""}>▲</button>
          <button class="btn-ghost pack-arrow" data-rp-down="${esc(p.fileName)}" title="Lower priority" ${dispIdx === enabledRows.length - 1 ? "disabled" : ""}>▼</button>` : ""}
        <button class="switch pack-switch${p.enabled ? " on" : ""}" role="switch" aria-checked="${p.enabled ? "true" : "false"}"
          data-rp-toggle="${esc(p.fileName)}" data-enabled="${p.enabled ? "1" : ""}" title="${p.enabled ? "Disable" : "Enable"}"><span class="knob"></span></button>
        <button class="btn-ghost world-x" data-pack-del="${esc(p.fileName)}" data-kind="resourcepack" title="Delete file">${ico("i-trash")}</button>
      </div>
    </div>`;

  const rpListHtml = rp.packs.length
    ? enabledRows.map(rpRow).join("") + disabledRows.map((p) => rpRow(p, -1)).join("")
    : `<div class="empty-line">No resource packs yet. Import a .zip, or add some from Discover.</div>`;

  // ---- Shader packs ----
  const shRow = (p) => {
    const active = sh.canSelect && sh.shadersOn && sh.selected === p.fileName;
    return `
    <div class="glass pack-row${active ? " on" : ""}">
      <div class="hit-icon ph">${ico("i-bolt")}</div>
      <div class="hit-meta">
        <div class="hit-title">${esc(packTitle(p))}${active ? `<span class="pack-pill live">ACTIVE</span>` : ""}</div>
        <div class="hit-desc">${p.isDir ? "folder pack" : esc(fmtSize(p.size))} · updated ${esc(fmtDate(p.modified))}</div>
      </div>
      <div class="pack-actions">
        ${sh.canSelect && !active ? `<button class="btn-soft" data-sh-use="${esc(p.fileName)}">Use</button>` : ""}
        ${active ? `<button class="btn-soft" data-sh-off="1">Turn off</button>` : ""}
        <button class="btn-ghost world-x" data-pack-del="${esc(p.fileName)}" data-kind="shader" title="Delete file">${ico("i-trash")}</button>
      </div>
    </div>`;
  };
  const shListHtml = sh.packs.length
    ? sh.packs.map(shRow).join("")
    : `<div class="empty-line">No shader packs yet. Import a .zip to get started.</div>`;

  // ---- Datapacks ----
  const dpRow = (p) => `
    <div class="glass pack-row">
      ${packIconHtml(p)}
      <div class="hit-meta">
        <div class="hit-title">${esc(packTitle(p))}</div>
        <div class="hit-desc">${packSubline(p)}</div>
      </div>
      <div class="pack-actions">
        <button class="btn-ghost world-x" data-pack-del="${esc(p.fileName)}" data-kind="datapack" title="Delete">${ico("i-trash")}</button>
      </div>
    </div>`;
  const worldOpts = pkWorlds.map((w) => `<option${w.name === selWorld ? " selected" : ""}>${esc(w.name)}</option>`).join("");
  const dpBody = !pkWorlds.length
    ? `<div class="empty-line">No worlds yet. Play the instance to create one. Datapacks live inside a world.</div>`
    : (dp.packs.length ? dp.packs.map(dpRow).join("") : `<div class="empty-line">No datapacks in ${esc(selWorld)} yet.</div>`);

  // ---- Keybinds ----
  let kbBody;
  if (!kb.hasOptions) {
    kbBody = `<div class="empty-line">No options.txt yet. Launch the instance once and Minecraft will create it. Then rebind anything here.</div>`;
  } else if (!kb.binds.length) {
    kbBody = `<div class="empty-line">No keybinds recorded yet. They appear here after the first launch.</div>`;
  } else {
    const groups = [];
    for (const cat of kb.categories) {
      const rows = kb.binds.filter((b) => b.category === cat);
      if (!rows.length) continue;
      groups.push(`
        <div class="kb-cat">${esc(cat.toUpperCase())}</div>
        <div class="kb-grid">
          ${rows.map((b) => `
            <div class="kb-row">
              <span class="kb-label" title="${esc(b.action)}">${esc(b.label)}</span>
              <button class="kb-key${b.conflict ? " conflict" : ""}" data-kb="${esc(b.action)}" data-label="${esc(b.label)}"
                title="${b.conflict ? "Also bound to another action. " : ""}Click, then press the new key">${esc(b.valueLabel)}</button>
              <button class="btn-ghost kb-reset" data-kb-reset="${esc(b.action)}" title="Reset to default">↺</button>
            </div>`).join("")}
        </div>`);
    }
    kbBody = groups.join("");
  }

  root.innerHTML = `
    <div class="section-head" style="margin-top:26px"><span class="section-title">RESOURCE PACKS</span>
      <span class="pack-head-actions">
        <button class="btn-soft" data-pack-import="resourcepack">${ico("i-download")} Import .zip</button>
        <button class="btn-soft" data-pack-open="resourcepack">Open folder</button>
      </span>
    </div>
    <div class="packs-list">${rpListHtml}</div>
    ${rp.packs.length ? `<div class="pack-note">Top of the list wins when packs overlap.${rp.hasOptions ? "" : " This instance hasn't launched yet. Enabling a pack writes a fresh options.txt the game picks up on first launch."}</div>` : ""}

    <div class="section-head" style="margin-top:26px"><span class="section-title">SHADER PACKS</span>
      <span class="pack-head-actions">
        <button class="btn-soft" data-pack-import="shader">${ico("i-download")} Import .zip</button>
        <button class="btn-soft" data-pack-open="shader">Open folder</button>
      </span>
    </div>
    <div class="packs-list">${shListHtml}</div>
    ${sh.canSelect
      ? `<div class="pack-note">Shader switching via ${esc(sh.configFile)}.${sh.shadersOn && sh.selected ? "" : " Shaders are currently off."}</div>`
      : (sh.packs.length ? `<div class="pack-note">To switch shaders from here, add Iris (Fabric/Quilt) or Oculus (Forge/NeoForge) to this instance and launch once. The files are managed above either way.</div>` : "")}

    <div class="section-head" style="margin-top:26px"><span class="section-title">DATAPACKS</span>
      ${pkWorlds.length ? `<select id="dp-world" class="dp-world">${worldOpts}</select>` : ""}
      <span class="pack-head-actions">
        <button class="btn-soft" data-pack-import="datapack" ${pkWorlds.length ? "" : "disabled"}>${ico("i-download")} Import .zip</button>
        <button class="btn-soft" data-pack-open="datapack" ${pkWorlds.length ? "" : "disabled"}>Open folder</button>
      </span>
    </div>
    <div class="packs-list">${dpBody}</div>

    <div class="section-head" style="margin-top:26px"><span class="section-title">KEYBINDS</span>
      <span class="pack-head-actions">
        ${kb.hasOptions && kb.binds.length ? `<button class="btn-soft" id="kb-reset-all">Reset all to defaults</button>` : ""}
      </span>
    </div>
    <div class="glass kb-panel">${kbBody}</div>`;

  bindPacksEvents(id, { rp, sh, dispOrder: enabledRows.map((p) => p.fileName), selWorld });
}

function bindPacksEvents(id, state) {
  const root = document.getElementById("packs-root");
  if (!root) return;
  const refresh = () => renderPacksSections(id);

  // Enable / disable a resource pack.
  root.querySelectorAll("[data-rp-toggle]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const fileName = b.dataset.rpToggle;
    const enable = !b.dataset.enabled;
    try {
      await API.packs.setResourcePack({ instanceId: id, fileName, enabled: enable });
      toast(enable ? `Enabled ${fileName}.` : `Disabled ${fileName}.`);
      refresh();
    } catch (e) { b.disabled = false; toast("Couldn't update: " + e.message); }
  });

  // Priority arrows. Display order is highest-first; options.txt stores the
  // reverse, so convert back before asking the engine to reorder.
  const move = async (fileName, delta) => {
    const disp = state.dispOrder.slice();
    const i = disp.indexOf(fileName);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= disp.length) return;
    [disp[i], disp[j]] = [disp[j], disp[i]];
    try {
      await API.packs.reorderResourcePacks({ instanceId: id, order: disp.slice().reverse() });
      refresh();
    } catch (e) { toast("Couldn't reorder: " + e.message); }
  };
  root.querySelectorAll("[data-rp-up]").forEach((b) => b.onclick = () => move(b.dataset.rpUp, -1));
  root.querySelectorAll("[data-rp-down]").forEach((b) => b.onclick = () => move(b.dataset.rpDown, 1));

  // Delete a pack file (any kind).
  root.querySelectorAll("[data-pack-del]").forEach((b) => b.onclick = async () => {
    const fileName = b.dataset.packDel;
    const kind = b.dataset.kind;
    // [wave0] trash-tier delete: packs go to the Recycle Bin (Mac parity)
    if (!confirm(`Move "${fileName}" to the Recycle Bin?`)) return;
    b.disabled = true;
    try {
      const r = await API.packs.delete({ instanceId: id, kind, fileName, world: kind === "datapack" ? state.selWorld : undefined });
      toast(r && r.trashed ? `Moved ${fileName} to the Recycle Bin.` : `Deleted ${fileName}.`); refresh();
    } catch (e) { b.disabled = false; toast("Couldn't delete: " + e.message); }
    // [/wave0]
  });

  // Import .zip(s) via the file picker.
  root.querySelectorAll("[data-pack-import]").forEach((b) => b.onclick = async () => {
    const kind = b.dataset.packImport;
    const original = b.innerHTML;
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Importing…`;
    try {
      const res = await API.packs.import({ instanceId: id, kind, world: kind === "datapack" ? state.selWorld : undefined });
      if (res === null) { b.disabled = false; b.innerHTML = original; return; }   // picker canceled
      const noMeta = res.filter((p) => p && p.missingMeta).length;
      toast(`Imported ${res.length} pack${res.length === 1 ? "" : "s"}.${noMeta && kind !== "shader" ? ` ${noMeta} ha${noMeta === 1 ? "s" : "ve"} no pack.mcmeta at the zip root. Minecraft may not accept ${noMeta === 1 ? "it" : "them"}.` : ""}`);
      refresh();
    } catch (e) { b.disabled = false; b.innerHTML = original; toast("Couldn't import: " + e.message); }
  });

  // Open the pack folder in the file manager.
  root.querySelectorAll("[data-pack-open]").forEach((b) => b.onclick = async () => {
    const kind = b.dataset.packOpen;
    try { await API.packs.openFolder({ instanceId: id, kind, world: kind === "datapack" ? state.selWorld : undefined }); }
    catch (e) { toast("Couldn't open: " + e.message); }
  });

  // Shader activate / deactivate.
  root.querySelectorAll("[data-sh-use]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await API.packs.selectShader({ instanceId: id, fileName: b.dataset.shUse }); toast(`Activated ${b.dataset.shUse}.`); refresh(); }
    catch (e) { b.disabled = false; toast("Couldn't activate: " + e.message); }
  });
  root.querySelectorAll("[data-sh-off]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await API.packs.selectShader({ instanceId: id, fileName: null }); toast("Shaders turned off."); refresh(); }
    catch (e) { b.disabled = false; toast("Couldn't turn off: " + e.message); }
  });

  // Datapacks world picker.
  const dw = document.getElementById("dp-world");
  if (dw) dw.onchange = () => { packsWorldSel[id] = dw.value; refresh(); };

  // Keybinds: capture-to-rebind, reset one, reset all.
  root.querySelectorAll("[data-kb]").forEach((b) => b.onclick = () => startKeyCapture(id, b));
  root.querySelectorAll("[data-kb-reset]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await API.keybinds.reset({ instanceId: id, action: b.dataset.kbReset }); toast("Reset to default. The game restores it on next launch."); refresh(); }
    catch (e) { b.disabled = false; toast("Couldn't reset: " + e.message); }
  });
  const ra = document.getElementById("kb-reset-all");
  if (ra) ra.onclick = async () => {
    if (!confirm("Reset every keybind to its default? Minecraft rebuilds them on the next launch.")) return;
    ra.disabled = true;
    try { await API.keybinds.resetAll(id); toast("All keybinds reset to defaults."); refresh(); }
    catch (e) { ra.disabled = false; toast("Couldn't reset: " + e.message); }
  };
}

// ---- Keybind capture: click a bind, press the new key (Esc cancels) ----
// DOM KeyboardEvent.code -> Minecraft key.keyboard.* names (GLFW naming).
const KB_CODE_TO_MC = (() => {
  const m = {
    Space: "space", Enter: "enter", Backspace: "backspace", Tab: "tab",
    Insert: "insert", Delete: "delete", Home: "home", End: "end",
    PageUp: "page.up", PageDown: "page.down",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    ShiftLeft: "left.shift", ShiftRight: "right.shift",
    ControlLeft: "left.control", ControlRight: "right.control",
    AltLeft: "left.alt", AltRight: "right.alt",
    MetaLeft: "left.win", MetaRight: "right.win",
    CapsLock: "caps.lock", NumLock: "num.lock", ScrollLock: "scroll.lock",
    PrintScreen: "print.screen", Pause: "pause", ContextMenu: "menu",
    Quote: "apostrophe", Comma: "comma", Minus: "minus", Period: "period", Slash: "slash",
    Semicolon: "semicolon", Equal: "equal", BracketLeft: "left.bracket", BracketRight: "right.bracket",
    Backslash: "backslash", Backquote: "grave.accent", IntlBackslash: "world.1",
    NumpadAdd: "keypad.add", NumpadSubtract: "keypad.subtract", NumpadMultiply: "keypad.multiply",
    NumpadDivide: "keypad.divide", NumpadDecimal: "keypad.decimal", NumpadEnter: "keypad.enter", NumpadEqual: "keypad.equal",
  };
  for (let i = 0; i <= 9; i++) { m["Digit" + i] = String(i); m["Numpad" + i] = "keypad." + i; }
  for (let i = 1; i <= 24; i++) m["F" + i] = "f" + i;
  for (const c of "abcdefghijklmnopqrstuvwxyz") m["Key" + c.toUpperCase()] = c;
  return m;
})();
const domCodeToMc = (code) => (KB_CODE_TO_MC[code] ? "key.keyboard." + KB_CODE_TO_MC[code] : null);
const domMouseToMc = (button) =>
  button === 0 ? "key.mouse.left" : button === 1 ? "key.mouse.middle" : button === 2 ? "key.mouse.right" : "key.mouse." + (button + 1);

let kbCapture = null;   // { cleanup } while listening for the next input

function cancelKeyCapture() {
  if (!kbCapture) return;
  const c = kbCapture; kbCapture = null;
  c.cleanup();
}

function startKeyCapture(instanceId, btn) {
  cancelKeyCapture();
  const action = btn.dataset.kb;
  const label = btn.dataset.label || action;
  const prev = btn.textContent;
  btn.classList.add("capturing");
  btn.textContent = "Press a key…";

  const commit = async (value) => {
    cancelKeyCapture();
    try {
      await API.keybinds.set({ instanceId, action, value });
      toast(`${label} rebound.`);
      renderPacksSections(instanceId);
    } catch (e) {
      toast("Couldn't rebind: " + e.message);
      renderPacksSections(instanceId);
    }
  };

  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.code === "Escape") { cancelKeyCapture(); return; }
    const mc = domCodeToMc(e.code);
    if (!mc) { toast("That key can't be bound."); return; }
    commit(mc);
  };
  let viaMouse = false;
  const onMouse = (e) => {
    e.preventDefault(); e.stopPropagation();
    viaMouse = true;
    commit(domMouseToMc(e.button));
  };
  const onCtx = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Swallows one click, then removes itself — so the click that completes a
  // mouse-button bind can't also press whatever the cursor happens to be over.
  const removeSwallow = () => document.removeEventListener("click", swallowClick, true);
  const swallowClick = (e) => { e.preventDefault(); e.stopPropagation(); removeSwallow(); };

  kbCapture = {
    cleanup() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onMouse, true);
      document.removeEventListener("contextmenu", onCtx, true);
      if (viaMouse) setTimeout(removeSwallow, 600);   // fallback if the trailing click never lands
      else removeSwallow();
      if (btn.isConnected) { btn.classList.remove("capturing"); btn.textContent = prev; }
    },
  };
  // Attach after the opening click has fully finished so it can't self-bind.
  setTimeout(() => {
    if (!kbCapture) return;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onMouse, true);
    document.addEventListener("contextmenu", onCtx, true);
    document.addEventListener("click", swallowClick, true);
  }, 0);
}

// ============================================================================
// [Icons + .lodepack — vertical feat/win-icons-lodepack] — additive section.
// Instance icons (user image or a generated letter tile) on every card + the
// detail hero, an icon picker modal, unified pack import (.mrpack / CurseForge
// .zip / .lodepack) with drag-and-drop, and ".lodepack export" in the Share
// modal. Everything here wraps existing bindings — it never edits them.

// ---- Icon cache: every API.instances() call feeds it ----
const LDI = { list: null, byId: new Map(), tiles: new Map(), loading: null };

function ldiRemember(list) {
  if (!Array.isArray(list)) return;
  LDI.list = list;
  LDI.byId = new Map(list.map((i) => [i.id, i]));
}
API.instances = ((orig) => async function () {
  const list = await orig();
  ldiRemember(list);
  return list;
})(API.instances.bind(API));

async function ldiEnsure() {
  if (LDI.list) return;
  if (!LDI.loading) LDI.loading = API.instances().catch(() => []).finally(() => { LDI.loading = null; });
  await LDI.loading;
}

// ---- Generated letter tiles (drawn in code — no binary assets) ----
// Used both as the fallback art for instances without an icon and as the
// built-in preset set in the picker (rasterized to a real icon.png on pick).
const LDI_GRADIENTS = [
  // [Design overhaul] tuned to the Deepslate & Glint palette — Minecraft-material hues.
  ["#8B93F8", "#5A5FCC"], ["#4E8ED9", "#2F5FA8"], ["#3FA98E", "#1F7A66"], ["#C98A3C", "#96601F"],
  ["#B75E6B", "#8A3A50"], ["#8A67C9", "#5E3F9E"], ["#6FA84A", "#47772B"], ["#8A93A6", "#4A5261"],
];
function ldiDrawTile(letter, grad, size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, grad[0]); g.addColorStop(1, grad[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const glow = ctx.createRadialGradient(size * 0.3, size * 0.18, 0, size * 0.3, size * 0.18, size);
  glow.addColorStop(0, "rgba(255,255,255,.26)"); glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, size, size);
  if (letter) {
    const family = (getComputedStyle(document.documentElement).getPropertyValue("--font-display") || "system-ui").trim() || "system-ui";
    ctx.fillStyle = "rgba(255,255,255,.94)";
    ctx.font = `700 ${Math.round(size * 0.46)}px ${family}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size * 0.55);
  }
  return canvas;
}
function ldiHash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; }
function ldiLetter(name) { return (String(name || "?").trim().charAt(0) || "?").toUpperCase(); }
function ldiFallbackURI(inst) {
  const letter = ldiLetter(inst.name);
  const grad = LDI_GRADIENTS[ldiHash(inst.id + "|" + letter) % LDI_GRADIENTS.length];
  const key = letter + grad[0];
  if (!LDI.tiles.has(key)) LDI.tiles.set(key, ldiDrawTile(letter, grad, 512).toDataURL("image/png"));
  return LDI.tiles.get(key);
}

// ---- Card + hero decoration (runs after every render via the bindCommon wrap) ----
function ldiApply(artEl, inst) {
  if (!artEl || !inst) return;
  const url = inst.iconPath ? `${fileURL(inst.iconPath)}?v=${inst.iconVersion || 0}` : ldiFallbackURI(inst);
  artEl.classList.add("ld-has-icon");
  artEl.style.backgroundImage = `url("${url}")`;
}

function ldiDecorate() {
  const root = el(); if (!root) return;
  ldiBindImport(root);
  const cards = root.querySelectorAll(".inst-card[data-open], .inst-card[data-play]");
  const hero = root.querySelector(".detail-hero");
  const heroPlay = hero && hero.querySelector(".detail-actions [data-play]");
  if (!cards.length && !heroPlay) return;
  if (!LDI.list) { ldiEnsure().then(() => ldiDecorate()); return; }
  cards.forEach((card) => ldiApply(card.querySelector(".inst-art"), LDI.byId.get(card.dataset.open || card.dataset.play)));
  if (heroPlay) {
    const inst = LDI.byId.get(heroPlay.dataset.play);
    const art = hero.querySelector(".inst-art");
    if (inst) ldiApply(art, inst);
    if (inst && art && !art.dataset.ldIcon) {
      art.dataset.ldIcon = "1";
      art.classList.add("ld-click");
      art.title = "Change icon";
      art.addEventListener("click", () => openIconModal(inst.id));
    }
    const actions = hero.querySelector(".detail-actions");
    if (inst && actions && !actions.querySelector("[data-ld-icon-btn]")) {
      const b = document.createElement("button");
      b.className = "btn-soft";
      b.setAttribute("data-ld-icon-btn", "1");
      b.innerHTML = `${ico("i-grid")} Icon`;
      b.onclick = () => openIconModal(inst.id);
      actions.appendChild(b);
    }
  }
}
bindCommon = ((orig) => function () { orig(); ldiDecorate(); })(bindCommon);

// ---- Icon picker modal ----
async function openIconModal(id) {
  await ldiEnsure();
  let inst = LDI.byId.get(id);
  if (!inst) { toast("Instance not found."); return; }
  const letter = ldiLetter(inst.name);
  const presets = LDI_GRADIENTS.map((g, idx) =>
    `<div class="ld-icon-tile" data-preset="${idx}" title="Use this tile" style="background-image:url('${ldiDrawTile(letter, g, 128).toDataURL("image/png")}')"></div>`).join("");
  showModal(`
    <div class="share-card">
      <div class="share-h">${ico("i-grid")} Instance icon</div>
      <p class="share-sub">Pick an image for <b>${esc(inst.name)}</b>, or use a built-in tile. It shows on the card and detail page, and travels inside exported <b>.lodepack</b> files.</p>
      <div class="ld-icon-row">
        <div class="ld-icon-preview" id="ld-icon-preview"></div>
        <div class="ld-icon-side">
          <button class="btn-accent" id="ld-icon-choose" style="width:auto">${ico("i-download")} Choose image…</button>
          <button class="btn-soft" id="ld-icon-remove" ${inst.icon ? "" : "disabled"}>${ico("i-trash")} Remove icon</button>
        </div>
      </div>
      <div class="share-label">BUILT-IN TILES</div>
      <div class="ld-icon-grid">${presets}</div>
      <div class="np-actions"><button class="btn-ghost" id="ld-icon-close">Close</button></div>
    </div>`);
  const modal = document.getElementById("modal");
  const preview = document.getElementById("ld-icon-preview");
  const paint = () => {
    const url = inst.iconPath ? `${fileURL(inst.iconPath)}?v=${inst.iconVersion || 0}` : ldiFallbackURI(inst);
    preview.style.backgroundImage = `url("${url}")`;
  };
  paint();
  const applied = (updated) => {
    if (!updated) return;
    inst = updated;
    LDI.byId.set(id, updated);
    if (LDI.list) LDI.list = LDI.list.map((x) => (x.id === id ? updated : x));
    paint();
    const rm = document.getElementById("ld-icon-remove");
    if (rm) rm.disabled = !updated.icon;
    ldiDecorate();   // live-refresh the card/hero behind the modal
  };
  document.getElementById("ld-icon-close").onclick = hideModal;
  document.getElementById("ld-icon-choose").onclick = async () => {
    try {
      const updated = await API.icons.pick(id);
      if (updated) { applied(updated); toast("Icon updated."); }
    } catch (e) { toast("Couldn't set the icon: " + e.message); }
  };
  document.getElementById("ld-icon-remove").onclick = async () => {
    try { applied(await API.icons.remove(id)); toast("Icon removed."); }
    catch (e) { toast("Couldn't remove the icon: " + e.message); }
  };
  modal.querySelectorAll("[data-preset]").forEach((tile) => tile.onclick = async () => {
    try {
      const grad = LDI_GRADIENTS[Number(tile.dataset.preset)];
      const dataURL = ldiDrawTile(letter, grad, 256).toDataURL("image/png");
      applied(await API.icons.set(id, dataURL.split(",")[1], "png"));
      toast("Icon updated.");
    } catch (e) { toast("Couldn't set the icon: " + e.message); }
  });
}

// ---- Unified pack import (button + drag-and-drop) ----
function ldiBindImport(root) {
  const btn = root.querySelector("#import-pack");
  if (!btn || btn.dataset.ldPacks || !API.hasEngine) return;
  btn.dataset.ldPacks = "1";
  btn.title = "Import a Modrinth .mrpack, CurseForge .zip, or Lodestone .lodepack";
  btn.onclick = () => ldiImportPack(null, btn);
}

function ldiImportToast(inst) {
  const s = inst.importSummary;
  if (s) {
    const bits = [];
    if (s.linked) bits.push(`${s.linked} linked`);
    if (s.bundled) bits.push(`${s.bundled} bundled`);
    if (s.includedConfigs) bits.push("configs");
    if (s.includedKeybinds) bits.push("keybinds");
    const failed = (s.failedDownloads || []).length;
    const skipped = s.skippedLocal || 0;
    toast(`Imported ${inst.name}${bits.length ? ` · ${bits.join(", ")}` : ""}` +
      `${failed ? `. ${failed} download${failed === 1 ? "" : "s"} failed. Import again to retry` : ""}` +
      `${skipped ? `. ${skipped} non-Modrinth item${skipped === 1 ? "" : "s"} skipped (v1 packs don't carry files)` : ""}.`);
  } else {
    const manual = (inst.manualDownloads && inst.manualDownloads.length) || 0;
    toast(manual
      ? `Imported ${inst.name}. ${manual} mod${manual === 1 ? "" : "s"} must be added by hand (the author blocked API downloads).`
      : `Imported ${inst.name}.`);
  }
}

async function ldiImportPack(path, btn) {
  const original = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Importing…`; }
  try {
    const inst = await API.lodepack.import(path || undefined);
    if (inst) {
      LDI.list = null;   // instance set changed; refill on next render
      ldiImportToast(inst);
      navigate("instances");
    } else if (btn) { btn.disabled = false; btn.innerHTML = original; }   // dialog canceled
  } catch (e) {
    toast("Couldn't import: " + e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

// Drop a pack file anywhere in the window to import it.
(function ldiSetupDrop() {
  if (!API.hasEngine || !window.lodestonePacks) return;
  const overlayEl = document.createElement("div");
  overlayEl.className = "ld-drop-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML = `<div class="ld-drop-card glass">${ico("i-download")}<div><b>Drop to import</b><span>.mrpack · CurseForge .zip · .lodepack</span></div></div>`;
  document.body.appendChild(overlayEl);
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlayEl.hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlayEl.hidden = true; });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; overlayEl.hidden = true;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.(mrpack|zip|lodepack)$/i.test(file.name)) { toast("Drop a .mrpack, CurseForge .zip, or .lodepack file."); return; }
    const p = API.lodepack.pathForFile(file);
    if (!p) { toast("Couldn't read the dropped file's path."); return; }
    toast(`Importing ${file.name}…`);
    await ldiImportPack(p, null);
  });
})();

// ---- ".lodepack export" rides along in the Share modal ----
openShareModal = ((orig) => async function (inst) {
  await orig(inst);
  const anchor = document.getElementById("share-mrpack");
  if (!anchor || document.getElementById("share-lodepack")) return;
  const b = document.createElement("button");
  b.className = "btn-soft";
  b.id = "share-lodepack";
  b.innerHTML = `${ico("i-download")} Export .lodepack`;
  b.title = "Lodestone's own pack file: mods + configs + keybinds + icon + RAM. Imports on Mac and Windows.";
  anchor.insertAdjacentElement("afterend", b);
  b.onclick = async () => {
    const original = b.innerHTML;
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Exporting…`;
    try {
      const res = await API.lodepack.exportLodepack(inst.id, inst.name);
      if (res) {
        const bits = [`${res.linked} linked`, `${res.bundled} bundled`];
        if (res.includedConfigs) bits.push("configs");
        if (res.includedKeybinds) bits.push("keybinds");
        toast(`Exported ${res.name}.lodepack · ${bits.join(", ")}.`);
      }
    } catch (e) { toast("Couldn't export: " + e.message); }
    b.disabled = false; b.innerHTML = original;
  };
})(openShareModal);
// ============================================================================
