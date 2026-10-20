// Tests for .claude/hooks/test-files-only.sh, the Edit/Write guard
// of the test-writer subagent.
// Run: node --test "tests/hooks/*.test.mjs"
// To test another copy of the hook: TEST_FILES_ONLY_HOOK=<path> node --test ...

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const hook =
  process.env.TEST_FILES_ONLY_HOOK ??
  fileURLToPath(
    new URL("../../.claude/hooks/test-files-only.sh", import.meta.url),
  );

// Temporary project with symlinks that point outside test files.
let base;
let root;
let outside;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "test-files-only-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");

  for (const dir of ["src/app", "src/lib", "tests", ".claude", outside]) {
    fs.mkdirSync(path.resolve(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "src/app/page.tsx"), "");
  fs.writeFileSync(path.join(root, "src/lib/utils.test.ts"), "");

  // A test-looking name that points at application code.
  fs.symlinkSync("../src/app/page.tsx", path.join(root, "tests/evil.test.tsx"));
  // A test directory that points outside the project.
  fs.symlinkSync(outside, path.join(root, "tests/out"));
  // A directory link back into application code.
  fs.symlinkSync("../src/app", path.join(root, "tests/app"));
  // A real test file reached through a link.
  fs.symlinkSync("../src/lib/utils.test.ts", path.join(root, "tests/utils.test.ts"));
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

// Shape of the PreToolUse input Claude Code sends to the hook.
function hookInput(toolInput, overrides = {}) {
  return {
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: toolInput,
    tool_use_id: "toolu_test",
    ...overrides,
  };
}

function run(stdin, env = { ...process.env, CLAUDE_PROJECT_DIR: root }) {
  const result = spawnSync("bash", [hook], { input: stdin, encoding: "utf8", env });
  return { code: result.status, stderr: result.stderr };
}

function guard(file, overrides) {
  return run(JSON.stringify(hookInput({ file_path: file, content: "" }, overrides)));
}

function expectAllowed(file) {
  const { code, stderr } = guard(file);
  assert.equal(code, 0, `expected ${file} to be allowed, got: ${stderr}`);
}

function expectBlocked(file, reason) {
  const { code, stderr } = guard(file);
  assert.equal(code, 2, `expected ${file} to be blocked`);
  assert.match(stderr, /^Blocked: /);
  if (reason) assert.match(stderr, reason);
}

describe("allowed files", () => {
  const allowed = [
    "src/lib/utils.test.ts",
    "src/components/button.test.tsx",
    "src/lib/format.spec.mts",
    "src/new/dir/created.test.ts",
    "src/__tests__/helpers.ts",
    "src/__mocks__/server.ts",
    "src/__fixtures__/user.json",
    "tests/helpers/render.tsx",
    "e2e/home.spec.ts",
    "./src/lib/utils.test.ts",
    "tests/utils.test.ts",
  ];
  for (const file of allowed) {
    test(`allows: ${file}`, () => expectAllowed(file));
  }

  test("allows an absolute path inside the project", () =>
    expectAllowed(path.join(root, "src/lib/utils.test.ts")));

  test("allows notebook_path", () => {
    const input = hookInput({ notebook_path: "tests/a.test.ts" });
    assert.equal(run(JSON.stringify(input)).code, 0);
  });
});

describe("blocks application code and shared setup", () => {
  const notTests = ["src/app/page.tsx", "src/lib/utils.ts", "package.json", "README.md"];
  for (const file of notTests) {
    test(`blocks: ${file}`, () => expectBlocked(file, /is not a test file/));
  }

  const setup = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.setup.ts",
    "playwright.config.ts",
    "src/setupTests.ts",
    "tests/setup.ts",
    "tests/global-setup.ts",
  ];
  for (const file of setup) {
    test(`blocks: ${file}`, () => expectBlocked(file, /shared test setup or config/));
  }

  const protectedDirs = [
    ".claude/a.test.ts",
    "node_modules/pkg/a.test.ts",
    ".git/a.test.ts",
    ".next/a.test.ts",
  ];
  for (const file of protectedDirs) {
    test(`blocks: ${file}`, () => expectBlocked(file, /protected directory/));
  }
});

describe("blocks paths outside the project", () => {
  for (const file of ["../a.test.ts", "src/../../a.test.ts", "/tmp/a.test.ts"]) {
    test(`blocks: ${file}`, () => expectBlocked(file, /outside the project/));
  }

  test("allows a name that only starts with two dots", () =>
    expectAllowed("..helpers.test.ts"));
});

describe("resolves symlinks", () => {
  test("blocks a test-named link to application code", () =>
    expectBlocked("tests/evil.test.tsx", /src\/app\/page\.tsx is not a test file/));

  test("blocks a new file in a test directory linked outside the project", () =>
    expectBlocked("tests/out/a.test.ts", /outside the project/));

  test("blocks a file reached through a directory link to app code", () =>
    expectBlocked("tests/app/page.tsx", /src\/app\/page\.tsx is not a test file/));
});

describe("project root", () => {
  test("falls back to cwd from the hook input", () => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const input = hookInput({ file_path: "src/app/page.tsx" });
    assert.equal(run(JSON.stringify(input), env).code, 2);
    const ok = hookInput({ file_path: "src/a.test.ts" });
    assert.equal(run(JSON.stringify(ok), env).code, 0);
  });
});

describe("hook input", () => {
  test("blocks invalid JSON", () => {
    assert.equal(run("not json").code, 2);
  });

  test("blocks empty input", () => {
    assert.equal(run("").code, 2);
  });

  test("blocks a missing file path", () => {
    const { code, stderr } = run(JSON.stringify(hookInput({ content: "" })));
    assert.equal(code, 2);
    assert.match(stderr, /no file path/);
  });

  test("blocks a non-string file path", () => {
    assert.equal(guard(["tests/a.test.ts"]).code, 2);
  });

  test("blocks when node is unavailable", () => {
    const result = spawnSync("/bin/bash", [hook], {
      input: JSON.stringify(hookInput({ file_path: "tests/a.test.ts" })),
      encoding: "utf8",
      env: { PATH: path.join(base, "no-such-dir"), CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Blocked: guard failed/);
  });
});
