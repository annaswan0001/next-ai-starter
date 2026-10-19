#!/usr/bin/env bash
# PreToolUse hook for subagents: allows only an exact list of read-only
# or test commands in Bash. Everything else is blocked with exit code 2.
# Usage: bash-guard.sh review|test
# Tests: node --test "tests/hooks/*.test.mjs"

set -euo pipefail

block() {
  printf 'Blocked: %s\n' "$1" >&2
  exit 2
}

if [ "$#" -ne 1 ] || { [ "$1" != review ] && [ "$1" != test ]; }; then
  block "expected mode 'review' or 'test'"
fi

# Any exit code other than 0 or 2 would not block the command in Claude
# Code (for example, a missing node or a crash), so it is mapped to 2.
status=0
GUARD_MODE="$1" node -e '
  const MAX_INPUT_BYTES = 1_000_000;
  const mode = process.env.GUARD_MODE;

  // Exact commands, compared word by word.
  const common = [
    "git --no-pager status --short",
    "git --no-pager diff --no-ext-diff --no-textconv",
    "git --no-pager diff --no-ext-diff --no-textconv --staged",
    "git --no-pager diff --no-ext-diff --no-textconv --stat",
    "git --no-pager diff --no-ext-diff --no-textconv --name-only",
    "git --no-pager ls-files --others --exclude-standard",
    "git --no-pager log -n 10 --oneline --no-decorate",
    "git --no-pager branch --show-current",
    "pnpm lint",
    "pnpm typecheck",
  ];
  // In test mode, optionally followed by test file paths.
  const vitest = ["pnpm", "exec", "vitest", "run"];

  const block = message => {
    process.stderr.write(`Blocked: ${message}\n`);
    process.exit(2);
  };

  // Splits on spaces and tabs. A double-quoted word must be a whole,
  // non-empty argument; quotes cannot appear anywhere else.
  const splitWords = command => {
    const words = [];
    const isSpace = ch => ch === " " || ch === "\t";

    for (let i = 0; i < command.length; ) {
      if (isSpace(command[i])) {
        i++;
      } else if (command[i] === "\"") {
        const end = command.indexOf("\"", i + 1);
        if (end === -1) block("unclosed quote");
        if (end + 1 < command.length && !isSpace(command[end + 1])) {
          block("quotes must wrap a whole argument");
        }
        const value = command.slice(i + 1, end);
        if (!value) block("empty argument");
        words.push({ value, quoted: true });
        i = end + 1;
      } else {
        let end = i;
        while (end < command.length && !isSpace(command[end])) end++;
        const value = command.slice(i, end);
        if (value.includes("\"")) block("quotes must wrap a whole argument");
        words.push({ value, quoted: false });
        i = end;
      }
    }
    return words;
  };

  const checkTestFile = file => {
    if (file.startsWith("-")) block(`flags are not allowed: ${file}`);

    const segments = file.replace(/^\.\//, "").split("/");
    if (segments.some(s => s === "" || s === "." || s === "..")) {
      block(`${file} must be a relative path inside the project`);
    }
    if (segments.some(s => s === "node_modules" || s === ".git" || s === ".next")) {
      block(`${file} is in a protected directory`);
    }
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(segments[segments.length - 1])) {
      block(`${file} is not a test file`);
    }
  };

  const check = raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      block("could not read hook input");
    }
    if (data === null || typeof data !== "object") block("could not read hook input");
    if (data.tool_name !== "Bash") block("this hook applies only to Bash");

    const input = data.tool_input ?? {};
    const command = input.command;
    if (typeof command !== "string" || !command.trim()) block("empty command");
    if (input.dangerouslyDisableSandbox === true) block("commands must run in the sandbox");
    if (input.run_in_background === true) block("background commands are not allowed");

    // Allowlist of characters, checked before parsing: rules out chaining,
    // pipes, redirection, substitution, variables, globs, escapes, comments
    // and newlines, including inside quotes.
    if (!/^[\w\-./" \t]+$/.test(command)) {
      block("only letters, digits, spaces, double quotes and - _ . / are allowed");
    }

    const words = splitWords(command);
    const unquoted = n => words.slice(0, n).every(w => !w.quoted);

    if (unquoted(words.length) && common.includes(words.map(w => w.value).join(" "))) {
      process.exit(0);
    }

    if (
      mode === "test" &&
      words.length >= vitest.length &&
      unquoted(vitest.length) &&
      vitest.every((word, k) => words[k].value === word)
    ) {
      words.slice(vitest.length).forEach(w => checkTestFile(w.value));
      process.exit(0);
    }

    block(`"${command.trim()}" is not on this agent allowlist; use the exact commands from the agent instructions`);
  };

  const chunks = [];
  let size = 0;

  // Keep reading past the limit so the writer does not get EPIPE.
  process.stdin.on("data", chunk => {
    size += chunk.length;
    if (size <= MAX_INPUT_BYTES) chunks.push(chunk);
  });
  process.stdin.on("error", () => block("could not read hook input"));
  process.stdin.on("end", () => {
    if (size > MAX_INPUT_BYTES) block("hook input is too large");
    check(Buffer.concat(chunks).toString("utf8"));
  });
' || status=$?

[ "$status" -eq 0 ] && exit 0
[ "$status" -eq 2 ] || block "guard failed (exit $status)"
exit 2
