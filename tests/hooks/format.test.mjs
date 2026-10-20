// Tests for .claude/hooks/format.sh, the PostToolUse hook that runs
// Prettier and ESLint on the edited file.
// Run: node --test "tests/hooks/*.test.mjs"
// To test another copy of the hook: FORMAT_HOOK=<path> node --test ...
//
// A fake `pnpm` on PATH records its arguments instead of running tools.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

const hook =
  process.env.FORMAT_HOOK ??
  fileURLToPath(new URL("../../.claude/hooks/format.sh", import.meta.url));

let base;
let root;
let bin;
let log;

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "format-hook-"));
  root = path.join(base, "project");
  bin = path.join(base, "bin");
  log = path.join(base, "pnpm.log");

  for (const file of [
    "src/app/page.tsx",
    "src/lib/utils.ts",
    "src/app/globals.css",
    "README.md",
    "public/logo.png",
    "node_modules/pkg/index.js",
    ".next/server/page.js",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  fs.writeFileSync(path.join(base, "outside.ts"), "");
  fs.symlinkSync("../outside.ts", path.join(root, "link.ts"));

  // Formatting runs only when the tools are installed.
  writeExecutable(path.join(root, "node_modules/.bin/prettier"), "#!/bin/sh\n");
  writeExecutable(path.join(root, "node_modules/.bin/eslint"), "#!/bin/sh\n");

  writeExecutable(
    path.join(bin, "pnpm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$PNPM_LOG"
case "$2" in
  prettier) echo "prettier output"; exit "\${FAKE_PRETTIER_EXIT:-0}" ;;
  eslint) echo "eslint output"; exit "\${FAKE_ESLINT_EXIT:-0}" ;;
esac
`,
  );
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

beforeEach(() => fs.rmSync(log, { force: true }));

// Shape of the PostToolUse input Claude Code sends to the hook.
function hookInput(toolInput) {
  return {
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: toolInput,
    tool_response: { success: true },
    tool_use_id: "toolu_test",
  };
}

function run(stdin, env = {}) {
  const result = spawnSync("/bin/bash", [hook], {
    input: stdin,
    encoding: "utf8",
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PNPM_LOG: log,
      CLAUDE_PROJECT_DIR: root,
      ...env,
    },
  });
  return { code: result.status, stderr: result.stderr };
}

function format(file, env) {
  return run(JSON.stringify(hookInput({ file_path: file })), env);
}

function calls() {
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n")
    : [];
}

describe("formatting", () => {
  test("runs Prettier and ESLint on a TypeScript file", () => {
    const { code, stderr } = format("src/app/page.tsx");
    assert.equal(code, 0, stderr);
    const file = fs.realpathSync(path.join(root, "src/app/page.tsx"));
    assert.deepEqual(calls(), [
      `exec prettier --write ${file}`,
      `exec eslint --fix --no-warn-ignored ${file}`,
    ]);
  });

  test("accepts an absolute path inside the project", () => {
    const { code } = format(path.join(root, "src/lib/utils.ts"));
    assert.equal(code, 0);
    assert.equal(calls().length, 2);
  });

  for (const file of ["src/app/globals.css", "README.md"]) {
    test(`runs only Prettier on ${file}`, () => {
      const { code } = format(file);
      assert.equal(code, 0);
      assert.deepEqual(
        calls().map((call) => call.split(" ")[1]),
        ["prettier"],
      );
    });
  }
});

describe("skipped files", () => {
  const cases = {
    "an unsupported extension": "public/logo.png",
    "a file in node_modules": "node_modules/pkg/index.js",
    "a file in .next": ".next/server/page.js",
    "a missing file": "src/app/missing.tsx",
    "a directory": "src/app",
    "a file outside the project": "../outside.ts",
    "a symlink pointing outside the project": "link.ts",
  };

  for (const [name, file] of Object.entries(cases)) {
    test(`skips ${name}`, () => {
      const { code, stderr } = format(file);
      assert.equal(code, 0, stderr);
      assert.deepEqual(calls(), []);
    });
  }

  test("skips formatting when Prettier is not installed", () => {
    const fresh = fs.mkdtempSync(path.join(base, "fresh-"));
    fs.writeFileSync(path.join(fresh, "page.tsx"), "");
    const { code } = format("page.tsx", { CLAUDE_PROJECT_DIR: fresh });
    assert.equal(code, 0);
    assert.deepEqual(calls(), []);
  });
});

describe("tool failures", () => {
  test("reports a Prettier failure to Claude", () => {
    const { code, stderr } = format("src/app/page.tsx", {
      FAKE_PRETTIER_EXIT: "1",
    });
    assert.equal(code, 2);
    assert.match(stderr, /Prettier failed for .*page\.tsx/);
    assert.match(stderr, /prettier output/);
    assert.equal(calls().length, 1, "ESLint must not run after Prettier fails");
  });

  test("reports an ESLint failure to Claude", () => {
    const { code, stderr } = format("src/app/page.tsx", {
      FAKE_ESLINT_EXIT: "1",
    });
    assert.equal(code, 2);
    assert.match(stderr, /ESLint failed for .*page\.tsx/);
    assert.match(stderr, /eslint output/);
  });
});

describe("hook input", () => {
  test("fails on invalid JSON", () => {
    const { code, stderr } = run("not json");
    assert.equal(code, 2);
    assert.match(stderr, /Cannot read the edited file path/);
  });

  test("fails on a missing file path", () => {
    const { code } = run(JSON.stringify(hookInput({})));
    assert.equal(code, 2);
  });

  test("fails without CLAUDE_PROJECT_DIR", () => {
    const { code, stderr } = format("src/app/page.tsx", {
      CLAUDE_PROJECT_DIR: "",
    });
    assert.equal(code, 2);
    assert.match(stderr, /CLAUDE_PROJECT_DIR is missing/);
  });
});
