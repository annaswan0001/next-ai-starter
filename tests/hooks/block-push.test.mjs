// Tests for .claude/hooks/block-push.sh, the project-wide PreToolUse
// guard against direct `git push` commands.
// Run: node --test "tests/hooks/*.test.mjs"
// To test another copy of the hook: BLOCK_PUSH_HOOK=<path> node --test ...

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const hook =
  process.env.BLOCK_PUSH_HOOK ??
  fileURLToPath(new URL("../../.claude/hooks/block-push.sh", import.meta.url));

// Shape of the PreToolUse input Claude Code sends to the hook.
function hookInput(toolInput) {
  return {
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { description: "Test command", ...toolInput },
    tool_use_id: "toolu_test",
  };
}

function run(stdin, env = process.env) {
  const result = spawnSync("/bin/bash", [hook], {
    input: stdin,
    encoding: "utf8",
    env,
  });
  return { code: result.status, stderr: result.stderr };
}

function check(command) {
  return run(JSON.stringify(hookInput({ command })));
}

describe("blocked commands", () => {
  const commands = [
    "git push",
    "git push origin main",
    "git push --force",
    "git -C . push",
    "git --no-pager push origin HEAD",
    "cd app && git push",
    "pnpm test; git push",
    "pnpm lint || git push",
    "git status | git push",
    "  git\tpush",
  ];

  for (const command of commands) {
    test(`blocks: ${JSON.stringify(command)}`, () => {
      const { code, stderr } = check(command);
      assert.equal(code, 2);
      assert.match(stderr, /git push is forbidden/);
    });
  }
});

describe("allowed commands", () => {
  const commands = [
    "git status",
    "git log --oneline",
    "git pull",
    "git fetch origin",
    "echo push",
    "github-cli push",
    "my-git push",
    "pnpm push-notifications",
  ];

  for (const command of commands) {
    test(`allows: ${JSON.stringify(command)}`, () => {
      const { code, stderr } = check(command);
      assert.equal(code, 0, stderr);
    });
  }
});

describe("hook input", () => {
  test("blocks invalid JSON", () => {
    const { code, stderr } = run("not json");
    assert.equal(code, 2);
    assert.match(stderr, /Bash execution blocked/);
  });

  test("blocks a missing command", () => {
    const { code } = run(JSON.stringify(hookInput({})));
    assert.equal(code, 2);
  });

  test("blocks a non-string command", () => {
    const { code } = run(JSON.stringify(hookInput({ command: ["git", "push"] })));
    assert.equal(code, 2);
  });

  test("blocks when node is unavailable", () => {
    const { code } = run(JSON.stringify(hookInput({ command: "git status" })), {
      PATH: path.join(os.tmpdir(), "no-such-dir"),
    });
    assert.equal(code, 2);
  });
});
