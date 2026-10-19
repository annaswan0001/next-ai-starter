#!/usr/bin/env bash
# PreToolUse hook for the test-writer agent:
# allows Edit/Write only on test files inside the project.
# Symlinks are resolved, so a link named like a test cannot point
# at application code or outside the project.

set -euo pipefail

# Any exit code other than 0 or 2 would not block the edit in Claude
# Code (for example, a missing node or a crash), so it is mapped to 2.
status=0
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let raw = "";

  const block = message => {
    process.stderr.write(`Blocked: ${message}\n`);
    process.exit(2);
  };

  // Real path of a file that may not exist yet (Write creates new files):
  // resolve the nearest existing ancestor, then append the rest.
  const realPath = target => {
    const rest = [];
    let current = target;
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...rest);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        rest.unshift(path.basename(current));
        current = parent;
      }
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => raw += chunk);
  process.stdin.on("error", () => block("could not read hook input"));
  process.stdin.on("end", () => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      block("could not read hook input");
    }
    if (data === null || typeof data !== "object") block("could not read hook input");

    const input = data.tool_input ?? {};
    const file = input.file_path ?? input.notebook_path;
    if (typeof file !== "string" || !file) block("no file path in tool input");

    let root, target;
    try {
      root = fs.realpathSync(path.resolve(process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd()));
      target = realPath(path.resolve(root, file));
    } catch (error) {
      block(`cannot resolve ${file}: ${error.message}`);
    }

    const rel = path.relative(root, target).split(path.sep).join("/");

    if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      block(`${file} is outside the project`);
    }

    if (/(^|\/)(node_modules|\.git|\.next|\.claude)\//.test(rel)) {
      block(`${rel} is in a protected directory`);
    }

    // Shared test setup and config need the user approval.
    if (/(^|\/)(vitest|playwright|jest)\.(config|setup|workspace)\.[cm]?[jt]sx?$/.test(rel) ||
        /(^|\/)(setup-?tests?|setup|global-?setup)\.[cm]?[jt]sx?$/i.test(rel)) {
      block(`${rel} is shared test setup or config; describe the change in the report instead`);
    }

    const isTestFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
    const isTestDir = /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|e2e)\//.test(rel);

    if (!isTestFile && !isTestDir) {
      block(`${rel} is not a test file; test-writer may edit only tests, test helpers and fixtures`);
    }

    process.exit(0);
  });
' || status=$?

[ "$status" -eq 0 ] && exit 0
[ "$status" -eq 2 ] || printf 'Blocked: guard failed (exit %s)\n' "$status" >&2
exit 2
