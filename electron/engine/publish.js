// Publish an instance as a public modpack.
//
// Three steps against Lodestone's own Cloudflare Worker (the same backend the
// Mac app publishes to, so a pack published from Windows and one published
// from Mac land in the same place and share the same /p/:id page format):
//
//   1. export a .lodepack of the instance
//   2. POST /v1/share?name=…  (octet-stream body)   -> { id, downloadURL }
//   3. POST /v1/publish       (json metadata)       -> { id, pageURL }
//
// Identity travels as x-ld-uuid / x-ld-username headers taken from the signed-in
// Minecraft account, matching SocialService.uploadPackToCentral on the Mac.
//
// Worlds are deliberately never included — exportLodepack only walks content,
// configs, keybinds, icon and RAM. Publishing a save would leak whatever the
// player built, and the pack page is public.
const fs = require("fs");
const os = require("os");
const path = require("path");

const lodepack = require("./lodepack");

// Lodestone's hosted worker. Kept identical to LodestoneCore/Config.swift so
// both clients publish to one place; overridable for a self-hosted relay.
const DEFAULT_BACKEND = "https://lodestone-social.films-jhop.workers.dev";

function backendURL(override) {
  let s = String(override || "").trim();
  if (!s) s = DEFAULT_BACKEND;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

// The worker answers errors as {"error":"..."} with a non-2xx code; surface that
// text rather than a bare status number, because its messages are already
// written for a person (e.g. the 24MB pack-too-big explanation).
async function readError(res, fallback) {
  let detail = "";
  try {
    const text = await res.text();
    try { detail = JSON.parse(text).error || ""; } catch { detail = text.slice(0, 200); }
  } catch { /* body already consumed or empty */ }
  return new Error(detail || `${fallback} (HTTP ${res.status})`);
}

// Publish. `onPhase` reports "exporting" | "uploading" | "publishing" so the UI
// can label the button honestly instead of one long indeterminate spinner.
async function publishInstance({ dataDir, instance, account, summary, backend, onPhase, onLog } = {}) {
  if (!instance) throw new Error("No instance to publish.");
  if (!account || !account.uuid) throw new Error("Sign in with your Microsoft account first — publishing is tied to your identity.");

  const base = backendURL(backend);
  const phase = (p) => { try { onPhase && onPhase(p); } catch {} };
  const log = (m) => { try { onLog && onLog(m); } catch {} };

  const tmp = path.join(os.tmpdir(), `${instance.id}-${Date.now()}.lodepack`);

  try {
    phase("exporting");
    log("Exporting a .lodepack of your enabled mods and configs…");
    await lodepack.exportLodepack({ dataDir, instance, outPath: tmp, author: account.name, onLog });

    const bytes = fs.readFileSync(tmp);

    phase("uploading");
    log(`Uploading ${(bytes.length / 1048576).toFixed(1)} MB…`);
    const shareRes = await fetch(`${base}/v1/share?name=${encodeURIComponent(instance.name || "pack")}`, {
      method: "POST",
      headers: {
        "x-ld-uuid": account.uuid,
        "x-ld-username": account.name || "Someone",
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    if (!shareRes.ok) throw await readError(shareRes, "Couldn't upload the pack");
    const uploaded = await shareRes.json();
    if (!uploaded || !uploaded.id) throw new Error("The backend didn't return a share id.");
    const downloadURL = uploaded.downloadURL || `${base}/v1/pack/${uploaded.id}`;

    phase("publishing");
    log("Creating the public install page…");
    const mods = (Array.isArray(instance.content) ? instance.content : [])
      .filter((c) => c && (c.kind || "mod") === "mod")
      .map((c) => c.title || c.fileName)
      .filter(Boolean);

    const metaRes = await fetch(`${base}/v1/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ld-uuid": account.uuid,
        "x-ld-username": account.name || "Someone",
      },
      body: JSON.stringify({
        name: instance.name,
        author: account.name,
        summary: String(summary || ""),
        mcVersion: instance.mcVersion,
        loader: instance.loader,
        mods,
        downloadURL,
      }),
    });
    if (!metaRes.ok) throw await readError(metaRes, "Couldn't publish the pack");
    const page = await metaRes.json();
    const pageURL = page && (page.pageURL || (page.id ? `${base}/p/${page.id}` : null));
    if (!pageURL) throw new Error("The backend didn't return a page URL.");

    log("Published.");
    return { pageURL, id: page.id, downloadURL, size: bytes.length, mods: mods.length };
  } finally {
    // The .lodepack is a build artifact; the copy that matters now lives on the
    // backend. Leaving it behind would quietly fill temp with pack-sized files.
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
  }
}

module.exports = { publishInstance, backendURL, DEFAULT_BACKEND };
