#!/usr/bin/env bash
# Stop: run typecheck when the working tree has TS changes.
# Report failures once; skip repeated Stop-hook continuation.

set -euo pipefail

fail() {
  echo "$1" >&2
  exit 2
}

if ! active=$(node -e '
  let input = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input);
      process.stdout.write(
        String(data.stop_hook_active === true)
      );
    } catch {
      process.exitCode = 1;
    }
  });
'); then
  fail "Cannot parse Stop hook input."
fi

# Avoid repeatedly blocking Claude on the same failure.
[ "$active" = "true" ] && exit 0

[ -n "${CLAUDE_PROJECT_DIR:-}" ] ||
  fail "CLAUDE_PROJECT_DIR is missing."

cd -- "$CLAUDE_PROJECT_DIR" ||
  fail "Cannot enter the project directory."

# Not a Git repo yet: nothing to compare, skip silently.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Include staged, unstaged, and untracked files.
# Handle repositories that do not yet have a first commit.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  tracked=$(git diff --name-only HEAD) ||
    fail "Cannot inspect tracked changes."
else
  tracked=$(git ls-files) ||
    fail "Cannot inspect tracked files."
fi

untracked=$(git ls-files --others --exclude-standard) ||
  fail "Cannot inspect untracked files."

# Run only when TS files are among the changes.
if ! grep -Eq '\.(ts|tsx|mts|cts)$' <<< "$tracked"$'\n'"$untracked"; then
  exit 0
fi

if ! out=$(pnpm typecheck 2>&1); then
  echo "Typecheck failed. Review the output and fix relevant issues:" >&2
  printf '%s\n' "$out" | tail -n 50 >&2
  exit 2
fi

exit 0