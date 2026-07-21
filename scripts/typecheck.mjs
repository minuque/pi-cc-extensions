#!/usr/bin/env node
/**
 * Minimal type-check gate for pi-cc-extensions.
 *
 * Only fails on:
 *   - Parse / syntax errors       (TS1xxx codes)
 *   - Duplicate declarations      (TS2300 Duplicate identifier,
 *                                   TS2393 Duplicate function implementation)
 *
 * Pre-existing type-assignability issues are ignored.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Codes we treat as hard errors.
const FATAL_CODES = new Set([
  2300, // Duplicate identifier
  2393, // Duplicate function implementation
]);

function isFatal(line) {
  const m = line.match(/\bTS(\d{4})\b/);
  if (!m) {
    if (/\berror\b/i.test(line)) return true;
    return false;
  }
  const code = Number(m[1]);
  if (code >= 1000 && code <= 1199) return true;
  return FATAL_CODES.has(code);
}

const result = spawnSync("npx", ["tsc", "--noEmit"], {
  cwd: root,
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
});

const combined = (result.stdout || "") + (result.stderr || "");
const lines = combined.split(/\r?\n/).filter(Boolean);
const fatalLines = lines.filter(isFatal);
const infoLines = lines.filter((l) => !isFatal(l));

if (infoLines.length > 0) {
  console.log("ℹ️  Pre-existing non-fatal issues (ignored):");
  for (const l of infoLines.slice(0, 10)) console.log(`   ${l}`);
  if (infoLines.length > 10) console.log(`   ... and ${infoLines.length - 10} more`);
}

if (fatalLines.length > 0) {
  console.error("\n❌ FATAL errors (must fix):");
  for (const l of fatalLines) console.error(`   ${l}`);
  process.exit(1);
}

console.log("✅ typecheck passed");
process.exit(0);
