#!/usr/bin/env node
// plumb bin wrapper
// - If dist/cli/plumb.js exists, run it directly with node (production)
// - Otherwise fall back to tsx on the TypeScript source (dev / post-install)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");
const env = { ...process.env, PLUMB_DIR: pkgDir };

const distEntry = resolve(pkgDir, "dist", "cli", "plumb.js");

if (existsSync(distEntry)) {
  // Production: run compiled JS directly
  const result = spawnSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  process.exit(result.status ?? 1);
} else {
  // Dev / first-run: use tsx to run TypeScript source
  const tsxBin = resolve(pkgDir, "node_modules", ".bin", "tsx");
  const cliPath = resolve(pkgDir, "cli", "plumb.ts");
  const result = spawnSync(
    existsSync(tsxBin) ? tsxBin : "tsx",
    [cliPath, ...process.argv.slice(2)],
    { stdio: "inherit", env }
  );
  process.exit(result.status ?? 1);
}
