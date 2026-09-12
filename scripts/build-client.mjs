#!/usr/bin/env node
/**
 * dsh-codex-approval — build the browser half (lib/client.js).
 *
 * DSH loads a client plugin as `window.__ModuleLoader__.load({ id, factory })`,
 * so the shipped artifact is an esbuild CJS bundle wrapped in that loader call.
 * React and every `@deepseek-ai/*` package stay external: the host's module
 * loader supplies them, and bundling them would duplicate the client runtime.
 *
 * Usage (from the package root):
 *   node scripts/build-client.mjs
 *
 * esbuild is not a dependency of this package (the published tarball has none),
 * so the script resolves it from npx unless ESBUILD_BIN is set.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_ID = "dsh-codex-approval";
const ENTRY = "src/client/index.ts";
const OUT = "lib/client.js";

const workdir = mkdtempSync(join(tmpdir(), "dsh-codex-approval-build-"));
const bundlePath = join(workdir, "client.bundle.cjs");
const esbuild = process.env.ESBUILD_BIN ?? "npx";
const esbuildArgs = process.env.ESBUILD_BIN === undefined ? ["--yes", "esbuild@0.25.0"] : [];

execFileSync(esbuild, [
	...esbuildArgs,
	ENTRY,
	"--bundle",
	"--format=cjs",
	"--platform=browser",
	"--target=es2022",
	"--jsx=transform",
	`--outfile=${bundlePath}`,
	"--external:react",
	"--external:react/*",
	"--external:@deepseek-ai/*",
	"--log-level=warning"
], { stdio: "inherit" });

const bundle = readFileSync(bundlePath, "utf8");
const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n${bundle}\nreturn module.exports; } });\n`;
writeFileSync(OUT, wrapped);
console.log(`built ${OUT} (${wrapped.length} bytes) from ${ENTRY}`);
