#!/usr/bin/env bash
# PostToolUse: format and lint the edited file.

set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

if ! f=$(node -e '
  let input = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input);
      const file = data.tool_input?.file_path;

      if (typeof file !== "string" || !file) {
        throw new Error("Missing file_path");
      }

      process.stdout.write(file);
    } catch {
      process.exitCode = 1;
    }
  });
'); then
  fail "Cannot read the edited file path from hook input."
fi

[ -n "${CLAUDE_PROJECT_DIR:-}" ] ||
  fail "CLAUDE_PROJECT_DIR is missing."

cd -- "$CLAUDE_PROJECT_DIR" ||
  fail "Cannot enter the project directory."

# Resolve symlinks and skip files outside the project.
if ! f=$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");

  try {
    const root = fs.realpathSync(process.cwd());
    const candidate = path.resolve(root, process.argv[1]);

    if (!fs.existsSync(candidate)) process.exit(0);

    const file = fs.realpathSync(candidate);
    const relative = path.relative(root, file);

    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      process.exit(0);
    }

    if (!fs.statSync(file).isFile()) process.exit(0);

    process.stdout.write(file);
  } catch (error) {
    console.error(`Cannot validate file path: ${error.message}`);
    process.exit(1);
  }
' -- "$f"); then
  fail "Cannot validate the edited file path."
fi

[ -n "$f" ] || exit 0

case "$f" in
  */node_modules/*|*/.next/*)
    exit 0 ;;
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
    lint=true ;;
  *.css|*.json|*.md)
    lint=false ;;
  *)
    exit 0 ;;
esac

# Dependencies not installed yet (fresh starter): nothing to format with.
[ -x node_modules/.bin/prettier ] || exit 0

if ! out=$(pnpm exec prettier --write "$f" 2>&1); then
  printf 'Prettier failed for %s:\n' "$f" >&2
  printf '%s\n' "$out" | tail -n 30 >&2
  exit 2
fi

if [ "$lint" = true ] && [ -x node_modules/.bin/eslint ]; then
  if ! out=$(pnpm exec eslint --fix --no-warn-ignored "$f" 2>&1); then
    printf 'ESLint failed for %s:\n' "$f" >&2
    printf '%s\n' "$out" | tail -n 30 >&2
    exit 2
  fi
fi

exit 0
