// Tests for .claude/hooks/stop-check.sh, the Stop hook that runs
// `pnpm typecheck` when TypeScript files changed.
// Run: node --test "tests/hooks/*.test.mjs"
// To test another copy of the hook: STOP_CHECK_HOOK=<path> node --test ...
//
// A fake `pnpm` on PATH records its arguments instead of running tsc.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

const hook =
  process.env.STOP_CHECK_HOOK ??
  fileURLToPath(new URL("../../.claude/hooks/stop-check.sh", import.meta.url));

let base;
let bin;
let log;
let gitConfig;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "stop-check-hook-"));
  bin = path.join(base, "bin");
  log = path.join(base, "pnpm.log");
  // Isolate the test repositories from the user's Git config (signing etc.).
  gitConfig = path.join(base, "gitconfig");
  fs.writeFileSync(gitConfig, "");

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$PNPM_LOG"
echo "src/a.ts(1,7): error TS2322: Type mismatch"
exit "\${FAKE_TYPECHECK_EXIT:-0}"
`,
    { mode: 0o755 },
  );
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

beforeEach(() => fs.rmSync(log, { force: true }));

const gitEnv = () => ({
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: base,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitEnv() },
  });
  assert.equal(result.status, 0, result.stderr);
}

// Creates a project directory with the given files.
function project({ repo = true, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(base, "project-"));
  if (repo) git(root, "init", "--quiet");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

function commitAll(root) {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "init");
}

function run(stdin, env = {}) {
  const result = spawnSync("/bin/bash", [hook], {
    input: stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      ...gitEnv(),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PNPM_LOG: log,
      ...env,
    },
  });
  return { code: result.status, stderr: result.stderr };
}

// Shape of the Stop input Claude Code sends to the hook.
function stop(root, { active = false, env = {} } = {}) {
  const input = {
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: active,
  };
  return run(JSON.stringify(input), { CLAUDE_PROJECT_DIR: root, ...env });
}

const typecheckRan = () =>
  fs.existsSync(log) && fs.readFileSync(log, "utf8").trim() === "typecheck";

describe("when typecheck runs", () => {
  test("runs for an untracked TypeScript file", () => {
    const root = project({ files: { "src/a.ts": "" } });
    const { code, stderr } = stop(root);
    assert.equal(code, 0, stderr);
    assert.ok(typecheckRan());
  });

  for (const ext of ["tsx", "mts", "cts"]) {
    test(`runs for a .${ext} file`, () => {
      const root = project({ files: { [`src/a.${ext}`]: "" } });
      stop(root);
      assert.ok(typecheckRan());
    });
  }

  test("runs for a modified committed file", () => {
    const root = project({ files: { "src/a.tsx": "a" } });
    commitAll(root);
    fs.writeFileSync(path.join(root, "src/a.tsx"), "b");
    stop(root);
    assert.ok(typecheckRan());
  });

  test("runs for a staged file in a repository without commits", () => {
    const root = project({ files: { "src/a.ts": "" } });
    git(root, "add", "-A");
    stop(root);
    assert.ok(typecheckRan());
  });
});

describe("when typecheck is skipped", () => {
  test("skips a clean repository", () => {
    const root = project({ files: { "src/a.ts": "" } });
    commitAll(root);
    const { code } = stop(root);
    assert.equal(code, 0);
    assert.ok(!typecheckRan());
  });

  test("skips changes without TypeScript files", () => {
    const root = project({ files: { "README.md": "", "src/a.css": "" } });
    const { code } = stop(root);
    assert.equal(code, 0);
    assert.ok(!typecheckRan());
  });

  test("skips a directory that is not a Git repository", () => {
    const root = project({ repo: false, files: { "src/a.ts": "" } });
    const { code } = stop(root);
    assert.equal(code, 0);
    assert.ok(!typecheckRan());
  });

  test("skips a repeated Stop after a reported failure", () => {
    const root = project({ files: { "src/a.ts": "" } });
    const { code } = stop(root, { active: true });
    assert.equal(code, 0);
    assert.ok(!typecheckRan());
  });
});

describe("typecheck failures", () => {
  test("reports the failure to Claude with the output", () => {
    const root = project({ files: { "src/a.ts": "" } });
    const { code, stderr } = stop(root, { env: { FAKE_TYPECHECK_EXIT: "1" } });
    assert.equal(code, 2);
    assert.match(stderr, /Typecheck failed/);
    assert.match(stderr, /error TS2322/);
  });
});

describe("hook input", () => {
  test("fails on invalid JSON", () => {
    const { code, stderr } = run("not json", { CLAUDE_PROJECT_DIR: base });
    assert.equal(code, 2);
    assert.match(stderr, /Cannot parse Stop hook input/);
  });

  test("fails without CLAUDE_PROJECT_DIR", () => {
    const root = project();
    const { code, stderr } = stop(root, { env: { CLAUDE_PROJECT_DIR: "" } });
    assert.equal(code, 2);
    assert.match(stderr, /CLAUDE_PROJECT_DIR is missing/);
  });
});
