// Tests for .claude/hooks/bash-guard.sh, the exact-command allowlist
// for Bash calls of the code-reviewer and test-writer subagents.
// Run: node --test "tests/hooks/*.test.mjs"
// To test another copy of the hook: BASH_GUARD_HOOK=<path> node --test ...

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const hook =
  process.env.BASH_GUARD_HOOK ??
  fileURLToPath(new URL("../../.claude/hooks/bash-guard.sh", import.meta.url));

// Shape of the PreToolUse input Claude Code sends to the hook.
function hookInput(toolInput, overrides = {}) {
  return {
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { description: "Test command", ...toolInput },
    tool_use_id: "toolu_test",
    ...overrides,
  };
}

function run(mode, stdin) {
  const args = mode === undefined ? [hook] : [hook, mode];
  const result = spawnSync("bash", args, { input: stdin, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

function guard(mode, command, extra = {}) {
  return run(mode, JSON.stringify(hookInput({ command, ...extra })));
}

function expectAllowed(mode, command) {
  const { code, stderr } = guard(mode, command);
  assert.equal(code, 0, `expected "${command}" to be allowed, got: ${stderr}`);
}

function expectBlocked(mode, command, extra) {
  const { code, stderr } = guard(mode, command, extra);
  assert.equal(code, 2, `expected ${JSON.stringify(command)} to be blocked`);
  assert.match(stderr, /^Blocked: /);
}

const DIFF = "git --no-pager diff --no-ext-diff --no-textconv";

const commonCommands = [
  "git --no-pager status --short",
  DIFF,
  `${DIFF} --staged`,
  `${DIFF} --stat`,
  `${DIFF} --name-only`,
  "git --no-pager ls-files --others --exclude-standard",
  "git --no-pager log -n 10 --oneline --no-decorate",
  "git --no-pager branch --show-current",
  "pnpm lint",
  "pnpm typecheck",
];

describe("allowed commands", () => {
  for (const mode of ["review", "test"]) {
    for (const command of commonCommands) {
      test(`${mode} allows: ${command}`, () => expectAllowed(mode, command));
    }
  }

  const testOnly = [
    "pnpm exec vitest run",
    "pnpm exec vitest run src/lib/utils.test.ts",
    "pnpm exec vitest run ./src/lib/utils.test.ts",
    "pnpm exec vitest run src/a.test.ts src/components/b.spec.tsx",
    "pnpm exec vitest run src/lib/format.test.mts",
    'pnpm exec vitest run "src/my folder/a.test.ts"',
    "  pnpm   exec vitest run  ",
  ];
  for (const command of testOnly) {
    test(`test allows: ${command}`, () => expectAllowed("test", command));
    test(`review blocks: ${command}`, () => expectBlocked("review", command));
  }
});

describe("blocks pipelines, chaining, substitution, redirection", () => {
  const blocked = [
    `${DIFF} | head -50`,
    `${DIFF} | sh`,
    "pnpm lint || pnpm typecheck",
    "pnpm lint && pnpm typecheck",
    "pnpm lint; pnpm typecheck",
    "pnpm lint & pnpm typecheck",
    "pnpm lint\npnpm typecheck",
    "git --no-pager log $(rm -rf src)",
    "git --no-pager log `rm -rf src`",
    "git --no-pager log ${HOME}",
    "git --no-pager log $HOME",
    `${DIFF} > patch.diff`,
    `${DIFF} >> patch.diff`,
    `${DIFF} < input`,
    `${DIFF} 2>&1`,
    "pnpm exec vitest run src/*.test.ts",
    "pnpm exec vitest run ~/a.test.ts",
    "pnpm lint # comment",
    "pnpm lint\\ --fix",
    // Operators are rejected even inside quotes.
    'pnpm exec vitest run "src/a|b.test.ts"',
    "pnpm exec vitest run 'src/$(x).test.ts'",
  ];
  for (const mode of ["review", "test"]) {
    for (const command of blocked) {
      test(`${mode} blocks: ${JSON.stringify(command)}`, () =>
        expectBlocked(mode, command));
    }
  }
});

describe("blocks arbitrary commands and flags", () => {
  const blocked = [
    // Close to allowlisted commands, but not exact.
    "git status",
    "git status --short",
    "git diff",
    "git diff --staged",
    "git --no-pager diff",
    `${DIFF} --output=patch.diff`,
    `${DIFF} -- src/app/page.tsx`,
    `${DIFF} --ext-diff`,
    "git --no-pager log -n 100 --oneline --no-decorate",
    "git --no-pager log -p",
    "git show HEAD",
    "git -c core.pager=sh --no-pager status --short",
    "pnpm lint --fix",
    "pnpm lint -- --fix",
    "pnpm typecheck --watch",
    "pnpm test",
    "pnpm test -- -u",
    "pnpm build",
    // Not allowlisted at all.
    "git commit -m x",
    "git push",
    "git checkout -- .",
    "rm -rf src",
    "cat .env",
    "node -e 1",
    "pnpm exec tsc --noEmit",
  ];
  for (const mode of ["review", "test"]) {
    for (const command of blocked) {
      test(`${mode} blocks: ${command}`, () => expectBlocked(mode, command));
    }
  }

  const vitestBlocked = [
    // Flags: watch, snapshot updates, reporters that write files.
    "pnpm exec vitest",
    "pnpm exec vitest watch",
    "pnpm exec vitest run -u",
    "pnpm exec vitest run --update",
    "pnpm exec vitest run src/a.test.ts -u",
    "pnpm exec vitest run src/a.test.ts --update",
    "pnpm exec vitest run --reporter=json src/a.test.ts",
    "pnpm exec vitest run --outputFile=out.json src/a.test.ts",
    // Paths outside the project or not test files.
    "pnpm exec vitest run ../other/a.test.ts",
    "pnpm exec vitest run src/../../a.test.ts",
    "pnpm exec vitest run /tmp/a.test.ts",
    "pnpm exec vitest run node_modules/pkg/a.test.ts",
    "pnpm exec vitest run .git/a.test.ts",
    "pnpm exec vitest run src/lib/utils.ts",
    "pnpm exec vitest run src",
    "pnpm exec vitest run src//a.test.ts",
    // Quoting the grammar does not support.
    'pnpm exec vitest run "src/a.test.ts',
    'pnpm exec vitest run "src/a".test.ts',
    'pnpm exec vitest run src/"a".test.ts',
    'pnpm exec vitest run ""',
  ];
  for (const command of vitestBlocked) {
    test(`test blocks: ${command}`, () => expectBlocked("test", command));
  }
});

describe("mode", () => {
  for (const mode of [undefined, "", "other", "REVIEW", "review test"]) {
    test(`blocks unknown mode: ${JSON.stringify(mode)}`, () => {
      const { code, stderr } = guard(mode, "pnpm lint");
      assert.equal(code, 2);
      assert.match(stderr, /expected mode 'review' or 'test'/);
    });
  }
});

describe("hook input", () => {
  test("blocks invalid JSON", () => {
    assert.equal(run("review", "not json").code, 2);
  });

  test("blocks empty input", () => {
    assert.equal(run("review", "").code, 2);
  });

  test("blocks oversized input", () => {
    const command = `pnpm lint ${"a".repeat(1_100_000)}`;
    assert.equal(guard("review", command).code, 2);
  });

  test("blocks a tool other than Bash", () => {
    const input = hookInput({ command: "pnpm lint" }, { tool_name: "Write" });
    const { code, stderr } = run("review", JSON.stringify(input));
    assert.equal(code, 2);
    assert.match(stderr, /only to Bash/);
  });

  test("blocks a missing command", () => {
    const input = hookInput({});
    assert.equal(run("review", JSON.stringify(input)).code, 2);
  });

  test("blocks a non-string command", () => {
    assert.equal(guard("review", ["pnpm", "lint"]).code, 2);
  });

  test("blocks an empty command", () => expectBlocked("review", "   "));

  test("blocks unsandboxed execution", () =>
    expectBlocked("review", "pnpm lint", { dangerouslyDisableSandbox: true }));

  test("blocks background execution", () =>
    expectBlocked("test", "pnpm exec vitest run", { run_in_background: true }));

  test("allows an explicit timeout", () => {
    assert.equal(guard("review", "pnpm lint", { timeout: 60000 }).code, 0);
  });
});
