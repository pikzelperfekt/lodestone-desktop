// Keybinds manager: reads/writes the `key_*` lines in an instance's options.txt.
// A line looks like `key_key.attack:key.mouse.left` — the option name after
// "key_" is the action's translation key, the value is a `key.keyboard.*` /
// `key.mouse.*` input name (or "key.keyboard.unknown" for unbound). Vanilla
// actions get human names + categories from the tables below; anything else
// (mod keybinds) falls back to a prettified translation key under "Mods & Other".
// Edits go through packs.js's byte-preserving line-file helpers, so every other
// options.txt line keeps its exact bytes. Resetting deletes the line — the game
// regenerates the default on next launch, exactly like the in-game "Reset".
const { instanceDir, readOptions, writeLineFile, setOption, removeOptions } = require("./packs");

// ---- Vanilla actions: translation key -> [category, human name] ----
// Order here is the display order within each category.
const VANILLA = {
  "key.forward": ["Movement", "Walk Forward"],
  "key.back": ["Movement", "Walk Backward"],
  "key.left": ["Movement", "Strafe Left"],
  "key.right": ["Movement", "Strafe Right"],
  "key.jump": ["Movement", "Jump"],
  "key.sneak": ["Movement", "Sneak"],
  "key.sprint": ["Movement", "Sprint"],
  "key.attack": ["Gameplay", "Attack / Destroy"],
  "key.use": ["Gameplay", "Use Item / Place Block"],
  "key.pickItem": ["Gameplay", "Pick Block"],
  "key.drop": ["Gameplay", "Drop Selected Item"],
  "key.inventory": ["Inventory", "Open / Close Inventory"],
  "key.swapOffhand": ["Inventory", "Swap Item With Offhand"],
  "key.hotbar.1": ["Inventory", "Hotbar Slot 1"],
  "key.hotbar.2": ["Inventory", "Hotbar Slot 2"],
  "key.hotbar.3": ["Inventory", "Hotbar Slot 3"],
  "key.hotbar.4": ["Inventory", "Hotbar Slot 4"],
  "key.hotbar.5": ["Inventory", "Hotbar Slot 5"],
  "key.hotbar.6": ["Inventory", "Hotbar Slot 6"],
  "key.hotbar.7": ["Inventory", "Hotbar Slot 7"],
  "key.hotbar.8": ["Inventory", "Hotbar Slot 8"],
  "key.hotbar.9": ["Inventory", "Hotbar Slot 9"],
  "key.loadToolbarActivator": ["Creative", "Load Toolbar"],
  "key.saveToolbarActivator": ["Creative", "Save Toolbar"],
  "key.chat": ["Multiplayer", "Open Chat"],
  "key.command": ["Multiplayer", "Open Command"],
  "key.playerlist": ["Multiplayer", "List Players"],
  "key.socialInteractions": ["Multiplayer", "Social Interactions"],
  "key.screenshot": ["Miscellaneous", "Take Screenshot"],
  "key.togglePerspective": ["Miscellaneous", "Toggle Perspective"],
  "key.smoothCamera": ["Miscellaneous", "Toggle Cinematic Camera"],
  "key.fullscreen": ["Miscellaneous", "Toggle Fullscreen"],
  "key.spectatorOutlines": ["Miscellaneous", "Highlight Players (Spectators)"],
  "key.advancements": ["Miscellaneous", "Advancements"],
};
const CATEGORY_ORDER = ["Movement", "Gameplay", "Inventory", "Creative", "Multiplayer", "Miscellaneous", "Mods & Other"];

// ---- key.keyboard.* / key.mouse.* -> human names ----
const KEY_NAMES = {
  unknown: "Not Bound", space: "Space", enter: "Enter", escape: "Escape", backspace: "Backspace",
  tab: "Tab", insert: "Insert", delete: "Delete", home: "Home", end: "End",
  "page.up": "Page Up", "page.down": "Page Down",
  up: "Up Arrow", down: "Down Arrow", left: "Left Arrow", right: "Right Arrow",
  "left.shift": "Left Shift", "right.shift": "Right Shift",
  "left.control": "Left Ctrl", "right.control": "Right Ctrl",
  "left.alt": "Left Alt", "right.alt": "Right Alt",
  "left.win": "Left Win", "right.win": "Right Win",
  "caps.lock": "Caps Lock", "num.lock": "Num Lock", "scroll.lock": "Scroll Lock",
  "print.screen": "Print Screen", pause: "Pause", menu: "Menu",
  apostrophe: "'", comma: ",", minus: "-", period: ".", slash: "/", semicolon: ";", equal: "=",
  "left.bracket": "[", "right.bracket": "]", backslash: "\\", "grave.accent": "`",
  "world.1": "World 1", "world.2": "World 2",
};
const KEYPAD_NAMES = { add: "+", subtract: "-", multiply: "*", divide: "/", decimal: ".", enter: "Enter", equal: "=" };

// Prettify a raw identifier: "socialInteractions" -> "Social Interactions",
// "toggle_smooth_camera" -> "Toggle Smooth Camera".
function prettify(raw) {
  return String(raw)
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Human name for a bound input value.
function keyLabel(value) {
  const v = String(value || "");
  if (v.startsWith("key.mouse.")) {
    const btn = v.slice(10);
    if (btn === "left") return "Left Button";
    if (btn === "right") return "Right Button";
    if (btn === "middle") return "Middle Button";
    return "Mouse " + prettify(btn);
  }
  if (v.startsWith("key.keyboard.")) {
    const k = v.slice(13);
    if (KEY_NAMES[k] != null) return KEY_NAMES[k];
    if (k.startsWith("keypad.")) {
      const kp = k.slice(7);
      return "Numpad " + (KEYPAD_NAMES[kp] != null ? KEYPAD_NAMES[kp] : kp.toUpperCase());
    }
    if (/^f\d+$/.test(k)) return k.toUpperCase();
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase();
    return prettify(k);
  }
  return v || "Not Bound";   // e.g. legacy numeric codes from very old versions
}

// Human name + category for an action's translation key.
function actionInfo(action) {
  const known = VANILLA[action];
  if (known) return { category: known[0], label: known[1] };
  let raw = action;
  if (raw.startsWith("key.")) raw = raw.slice(4);
  return { category: "Mods & Other", label: prettify(raw) };
}

// All keybinds in options.txt, annotated and in a stable display order (vanilla
// category order first, then mod binds; file order preserved within a group).
// An instance that never launched has no options.txt: hasOptions:false, no throw.
function list(dataDir, instanceId) {
  const doc = readOptions(instanceDir(dataDir, instanceId));
  if (!doc.exists) return { hasOptions: false, binds: [], categories: CATEGORY_ORDER };
  const binds = [];
  for (const p of doc.parts) {
    if (!p.text.startsWith("key_")) continue;
    const sep = p.text.indexOf(":");
    if (sep < 0) continue;
    const action = p.text.slice(4, sep);
    const value = p.text.slice(sep + 1);
    const info = actionInfo(action);
    binds.push({ action, value, valueLabel: keyLabel(value), category: info.category, label: info.label });
  }
  // Mark conflicts: the same input bound to two or more actions (unbound excluded).
  const seen = {};
  for (const b of binds) if (b.value !== "key.keyboard.unknown") seen[b.value] = (seen[b.value] || 0) + 1;
  for (const b of binds) b.conflict = b.value !== "key.keyboard.unknown" && seen[b.value] > 1;
  const catRank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
  binds.sort((a, b) => catRank(a.category) - catRank(b.category));  // stable: file order within a category
  return { hasOptions: true, binds, categories: CATEGORY_ORDER };
}

// Rebind one action. `value` must be a Minecraft input name; the UI translates
// the captured keypress (KeyboardEvent.code / mouse button) into it.
function set(dataDir, instanceId, action, value) {
  const act = String(action || "").trim();
  const val = String(value || "").trim();
  if (!act || /[\s:]/.test(act)) throw new Error("Invalid keybind action.");
  if (!/^key\.(keyboard|mouse)\.[a-z0-9.]+$/i.test(val)) throw new Error("Invalid key value.");
  const doc = readOptions(instanceDir(dataDir, instanceId));
  if (!doc.exists) throw new Error("This instance has no options.txt yet — launch it once, then set keybinds.");
  setOption(doc, "key_" + act, val);
  writeLineFile(doc);
  return list(dataDir, instanceId);
}

// Reset one action to its default by deleting its line — the game writes the
// default back on next launch (the in-game "Reset" behaves the same way).
function reset(dataDir, instanceId, action) {
  const act = String(action || "").trim();
  if (!act) throw new Error("Invalid keybind action.");
  const doc = readOptions(instanceDir(dataDir, instanceId));
  if (!doc.exists) return list(dataDir, instanceId);
  removeOptions(doc, (text) => text.startsWith("key_" + act + ":"));
  writeLineFile(doc);
  return list(dataDir, instanceId);
}

// Reset every keybind: delete all key_* lines; the game regenerates defaults.
function resetAll(dataDir, instanceId) {
  const doc = readOptions(instanceDir(dataDir, instanceId));
  if (!doc.exists) return list(dataDir, instanceId);
  removeOptions(doc, (text) => text.startsWith("key_"));
  writeLineFile(doc);
  return list(dataDir, instanceId);
}

module.exports = { list, set, reset, resetAll, keyLabel, actionInfo, VANILLA, CATEGORY_ORDER };
