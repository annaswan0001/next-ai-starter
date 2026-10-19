#!/usr/bin/env bash
# PreToolUse: block recognizable direct git push commands.
# Additional guard, not a complete shell-command parser.

set -euo pipefail

if ! cmd=$(node -e '
  let input = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input);
      const command = data.tool_input?.command;

      if (typeof command !== "string") {
        throw new Error("Missing command");
      }

      process.stdout.write(command);
    } catch {
      process.exitCode = 1;
    }
  });
'); then
  echo "Cannot validate command. Bash execution blocked." >&2
  exit 2
fi

pattern='(^|[^[:alnum:]_-])git([[:space:]]+[^;&|]*)?[[:space:]]push([[:space:]]|$)'

if [[ "$cmd" =~ $pattern ]]; then
  echo "git push is forbidden. Ask the user to push manually." >&2
  exit 2
fi

exit 0