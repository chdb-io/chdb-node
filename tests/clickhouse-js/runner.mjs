#!/usr/bin/env node
/**
 * chdb-node × @clickhouse/client cross-suite parity runner.
 *
 * Clones @clickhouse/client at a configured ref, builds it, patches
 * upstream's `vitest.node.setup.ts` in-place to wrap
 * `globalThis.environmentSpecificCreateClient` with `createChdbConnection`,
 * then runs the integration suite filtered by
 * `tests/clickhouse-js/skip_list.json`. The setup patch is restored in a
 * try/finally block so the upstream checkout isn't left dirty.
 *
 * Sync policy (encoded in skip_list.json's `syncedAgainst` block):
 *
 *   stage of the upstream injection PR     →  ref this runner uses
 *   ----------------------------------------+-----------------------
 *   open on the personal fork               →  ShawnChen-Sirius/clickhouse-js
 *                                              feat/pluggable-connection
 *   merged to ClickHouse/clickhouse-js     →  ClickHouse/clickhouse-js main
 *   (current state — #879 is merged)
 *   released                                →  the latest released tag
 *
 * Override at runtime:
 *
 *   CHDB_CLICKHOUSE_JS_REPO=https://github.com/.../clickhouse-js.git
 *   CHDB_CLICKHOUSE_JS_REF=main
 *
 * Usage:
 *
 *   node tests/clickhouse-js/runner.mjs              — run the whole suite
 *   node tests/clickhouse-js/runner.mjs --refresh    — re-clone (no cache)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const SKIP = JSON.parse(readFileSync(join(HERE, "skip_list.json"), "utf8"));
const synced = SKIP.syncedAgainst || {};

const REPO = process.env.CHDB_CLICKHOUSE_JS_REPO
  || (synced.ref?.startsWith("ShawnChen-Sirius/")
        ? "https://github.com/ShawnChen-Sirius/clickhouse-js.git"
        : "https://github.com/ClickHouse/clickhouse-js.git");
const REF = process.env.CHDB_CLICKHOUSE_JS_REF
  || synced.ref?.split(" ").pop()
  || "main";

const WORK_DIR = process.env.CHDB_RUNNER_WORK_DIR
  || join(REPO_ROOT, ".chdb-runner", "clickhouse-js");
const REFRESH = process.argv.includes("--refresh");

function sh(cmd, args, opts = {}) {
  console.log(`[runner] $ ${cmd} ${args.join(" ")}${opts.cwd ? `   (in ${opts.cwd})` : ""}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} → exit ${r.status}`);
  }
}

function clone() {
  if (REFRESH && existsSync(WORK_DIR)) {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
  if (existsSync(WORK_DIR)) {
    // Reset any setup-file patches from a previous run, then update to REF.
    // `git pull origin <REF>` fails when REF is a tag (the sync policy
    // points at the latest released tag, not a branch). `fetch + checkout`
    // handles both branches and tags uniformly.
    sh("git", ["-C", WORK_DIR, "reset", "--hard", "HEAD"]);
    sh("git", ["-C", WORK_DIR, "fetch", "--tags", "origin"]);
    sh("git", ["-C", WORK_DIR, "checkout", REF]);
    return;
  }
  mkdirSync(dirname(WORK_DIR), { recursive: true });
  sh("git", ["clone", "--depth", "50", "--branch", REF, REPO, WORK_DIR]);
}

function installAndBuild() {
  sh("npm", ["install"], { cwd: WORK_DIR });
  sh("npm", ["--workspaces", "run", "build"], { cwd: WORK_DIR });
  // Link this chdb-node checkout as the `chdb` dependency so the injection
  // setup can `import { createChdbConnection } from 'chdb/connection'`.
  sh("npm", ["install", REPO_ROOT, "--save-dev"], { cwd: WORK_DIR });
}

// Sentinel comment block — used to identify our injected snippet so we can
// strip it back out even if a previous run crashed before restoration.
const CHDB_INJECTION_BEGIN = "// >>> chdb-runner injection — DO NOT EDIT >>>";
const CHDB_INJECTION_END   = "// <<< chdb-runner injection — DO NOT EDIT <<<";

/**
 * Append the ChdbConnection wrapping snippet to upstream's
 * `vitest.node.setup.ts` so vitest actually loads it (the setup file is
 * already in upstream's `setupFiles` config, so appending to it is the
 * one mechanism guaranteed to be picked up regardless of vitest version
 * or CLI flag support). Returns a `{file, original}` snapshot for
 * try/finally restoration.
 */
function injectSetup() {
  const target = join(WORK_DIR, "vitest.node.setup.ts");
  if (!existsSync(target)) {
    throw new Error(
      `[runner] upstream vitest.node.setup.ts not found at ${target}; ` +
      `injection cannot proceed`,
    );
  }
  const original = readFileSync(target, "utf8");
  // Strip any leftover injection from a prior crashed run, then append fresh.
  const cleaned = stripInjection(original);
  const SNIPPET = `

${CHDB_INJECTION_BEGIN}
// Wrap globalThis.environmentSpecificCreateClient so every createClient
// in the integration suite gets a ChdbConnection injected. Runs only
// when CH_TEST_BACKEND=chdb; the default code path stays unchanged.
// @ts-expect-error require() is fine in setup files
const __chdb = require("chdb/connection");
// @ts-expect-error require() is fine in setup files
const __chdbCreate = require("@clickhouse/client").createClient;
if (process.env.CH_TEST_BACKEND === "chdb") {
  // @ts-expect-error overriding the upstream global on purpose
  globalThis.environmentSpecificCreateClient = (config) => {
    const connection = __chdb.createChdbConnection({ path: ":memory:" });
    return __chdbCreate({ ...(config || {}), connection });
  };
  console.log("[chdb-runner] createClient wrapped with ChdbConnection");
}
${CHDB_INJECTION_END}
`;
  writeFileSync(target, cleaned + SNIPPET);
  return { file: target, original };
}

function stripInjection(content) {
  const start = content.indexOf(CHDB_INJECTION_BEGIN);
  if (start === -1) return content;
  const end = content.indexOf(CHDB_INJECTION_END);
  if (end === -1) return content;  // malformed; leave alone
  // Trim the leading blank line(s) we added before BEGIN as well.
  return content.slice(0, start).replace(/\n+$/, "\n") + content.slice(end + CHDB_INJECTION_END.length).replace(/^\n+/, "");
}

function restoreSetup(snapshot) {
  if (!snapshot) return;
  try {
    writeFileSync(snapshot.file, snapshot.original);
  } catch (e) {
    console.warn(`[runner] failed to restore ${snapshot.file}: ${e.message}`);
  }
}

function buildSkipPattern() {
  const files = (SKIP.skipFiles || []).map((entry) =>
    typeof entry === "string" ? entry : entry.file);
  return files;
}

/**
 * For each `skipTests` entry, patch the relevant test file in place so the
 * matching `it("<name>"` becomes `it.skip("<name>"` (and same for `test(`).
 * Returns a list of `{ file, original }` snapshots so the caller can
 * restore the originals after vitest finishes. vitest 2.x has no native
 * test-id-level skip via CLI, so in-place patching is the simplest
 * cross-file mechanism.
 */
function applyPerTestSkips() {
  const entries = SKIP.skipTests || [];
  if (entries.length === 0) return [];
  const patches = [];
  // Group entries by file so we make one read/write per file.
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const [relFile, list] of byFile) {
    const abs = join(WORK_DIR, relFile);
    if (!existsSync(abs)) {
      console.warn(`[runner] skipTests file not found, ignoring: ${relFile}`);
      continue;
    }
    const original = readFileSync(abs, "utf8");
    let patched = original;
    let applied = 0;
    for (const e of list) {
      // The vitest test node-id is `<file> > <describe...> > <it-name>`.
      // We only need the LAST segment (the `it` name) to locate the
      // `it("<name>"` call in the source.
      const itName = e.test.split(" > ").pop();
      // Escape regex metacharacters in the it name.
      const escaped = itName
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match `it(` or `test(` followed by the string literal of itName.
      const re = new RegExp(
        String.raw`\b(it|test)\(\s*(['"\`])${escaped}\2`,
        "g",
      );
      const next = patched.replace(re, "$1.skip($2" + itName + "$2");
      if (next !== patched) {
        applied += 1;
        patched = next;
      } else {
        console.warn(
          `[runner] skipTests: pattern not found in ${relFile}: ${itName}`,
        );
      }
    }
    if (patched !== original) {
      writeFileSync(abs, patched);
      patches.push({ file: abs, original });
      console.log(
        `[runner] applied ${applied} per-test skip(s) to ${relFile}`,
      );
    }
  }
  return patches;
}

function restorePerTestSkips(patches) {
  for (const { file, original } of patches) {
    try {
      writeFileSync(file, original);
    } catch (e) {
      console.warn(`[runner] failed to restore ${file}: ${e.message}`);
    }
  }
}

function runVitest() {
  const setupSnap = injectSetup();
  const excludes = buildSkipPattern();
  const patches = applyPerTestSkips();
  try {
    const args = [
      "run",
      "test:node:integration",
      "--",
      "--config",
      "vitest.node.config.ts",
    ];
    for (const f of excludes) args.push("--exclude", f);
    const env = {
      ...process.env,
      TZ: "UTC",
      CH_TEST_BACKEND: "chdb",
    };
    sh("npm", args, { cwd: WORK_DIR, env });
  } finally {
    restorePerTestSkips(patches);
    restoreSetup(setupSnap);
  }
}

console.log(`[runner] @clickhouse/client repo: ${REPO}`);
console.log(`[runner] ref:                       ${REF}`);
console.log(`[runner] work dir:                  ${WORK_DIR}`);
console.log(`[runner] skip_list entries:         ${(SKIP.skipFiles || []).length} files`);
console.log();

clone();
installAndBuild();
runVitest();
