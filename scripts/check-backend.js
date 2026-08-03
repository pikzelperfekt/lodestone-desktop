#!/usr/bin/env node
// Check which parts of the Lodestone backend are actually live.
//
// Reads the shipped cloud.config.json and probes each table through PostgREST
// with the public anon key. A 200 (or an RLS-empty 200) means the table exists;
// a 404 means its migration has not been applied yet.
//
//   node scripts/check-backend.js
const fs = require("fs");
const path = require("path");
const https = require("https");

const cfgPath = path.join(__dirname, "..", "electron", "cloud.config.json");
let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
catch { console.error("Couldn't read electron/cloud.config.json"); process.exit(2); }

if (!cfg.url || !cfg.anonKey) {
  console.error("cloud.config.json has no url/anonKey yet — see SETUP.md.");
  process.exit(2);
}

// table -> the migration that creates it
const TABLES = {
  profiles: "0001_accounts_foundation.sql",
  friendships: "0001_accounts_foundation.sql",
  squads: "0001_accounts_foundation.sql",
  squad_members: "0001_accounts_foundation.sql",
  messages: "0001_accounts_foundation.sql",
  synced_instances: "0001_accounts_foundation.sql",
  shared_packs: "0003_shared_packs.sql",
  shared_pack_members: "0003_shared_packs.sql",
};

function probe(table) {
  return new Promise((resolve) => {
    const url = new URL(`${cfg.url}/rest/v1/${table}?select=*&limit=1`);
    const req = https.request(url, {
      method: "GET",
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

(async () => {
  console.log(`Backend: ${cfg.url}\n`);
  const missing = new Set();
  for (const [table, migration] of Object.entries(TABLES)) {
    const code = await probe(table);
    const live = code === 200 || code === 206;
    if (!live) missing.add(migration);
    const label = live ? "live" : code === 404 ? "MISSING" : `HTTP ${code || "unreachable"}`;
    console.log(`  ${live ? "✓" : "✗"} ${table.padEnd(22)} ${label}`);
  }

  if (!missing.size) {
    console.log("\nEverything is applied. Sharing and sync are fully live.");
    return;
  }
  console.log(`\nNot applied yet: ${[...missing].join(", ")}`);
  console.log("Apply it in the Supabase dashboard → SQL Editor → paste → Run:");
  for (const m of missing) console.log(`  supabase/migrations/${m}`);
  console.log("\nA failed run rolls back whole, so a re-run after fixing needs no drops.");
  process.exitCode = 1;
})();
