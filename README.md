# next-ai-starter

A starter for Next.js projects where most of the code is written with
Claude Code.

This is **a recipe, not an application**: there is no `package.json` and no
app code. The starter holds a configured environment for the AI agent
(rules, agents, skills, hooks, permissions, sandbox) and a `/bootstrap`
skill that creates a new project with the **latest** library versions.
From then on, the project's own lockfile pins them, so the starter never
goes stale along with its dependencies.

## Stack

Next.js App Router (16+), React, strict TypeScript, Tailwind CSS v4
(CSS-first), shadcn/ui, Zod, Prettier, ESLint, Vitest + React Testing Library.

Optional, chosen during `/bootstrap`: next-intl, TanStack Query,
TanStack Table, nuqs, Playwright.

Package manager: pnpm only.

## Requirements

- Node.js (LTS), pnpm, rsync
- Claude Code
- Optional: `CONTEXT7_API_KEY` for the Context7 MCP server (it works without
  a key, with lower rate limits)

## Creating a project

1. Open Claude Code in the starter directory and run:

   ```
   /bootstrap my-app
   ```

   The agent checks the current `create-next-app` flags and gives you two
   commands: create the project next to the starter and copy the setup into
   it. You run them yourself (the agent is not allowed to install packages).

2. Open Claude Code in the new project and run `/bootstrap` again.
   The agent:
   - checks the base configuration and installed versions;
   - asks which optional libraries the project needs (each comes with a
     note on when it is **not** needed);
   - gives you the install commands;
   - configures Prettier, ESLint, Vitest and the chosen libraries, checking
     the docs for the installed version first each time;
   - updates `CLAUDE.md` to match the actual stack;
   - runs `lint`, `typecheck`, `test`, `build` and reports the results.

3. Review the diff and make the first commit yourself (the agent does not
   commit).

## What's inside

```
CLAUDE.md                 main agent instructions: stack, commands, structure
.mcp.json                 Context7: docs matching installed versions
.claude/
  settings.json           permissions, sandbox, hooks, plugins
  rules/                  conventions loaded by file path
  agents/                 subagents with restricted permissions
  skills/                 on-demand checklists and /bootstrap
  hooks/                  scripts run by Claude Code
```

### Rules (`.claude/rules/`)

Loaded only when the agent works with matching files:

| File               | Applies to                       | Covers                                             |
| ------------------ | -------------------------------- | -------------------------------------------------- |
| `typescript.md`    | `*.ts`, `*.tsx`                  | no `any`, `!`, `@ts-ignore`; Zod at boundaries     |
| `react.md`         | `*.tsx`, hooks                   | state, effects, no routine memoization             |
| `nextjs.md`        | `src/app/**`                     | server/client boundaries, Next 16 caching, errors  |
| `nextjs-server.md` | actions, route handlers, proxy   | every action is a public endpoint                  |
| `tailwind.md`      | `*.tsx`, `*.css`                 | Tailwind v4 pitfalls, shadcn tokens                |
| `accessibility.md` | UI files                         | WCAG 2.2 AA                                        |
| `i18n.md`          | `*.tsx`, `messages/`, `src/i18n` | next-intl, ICU, Ukrainian plural forms             |

Version-dependent guidance is marked with a
`Version-specific … Revisit after a major release` comment.

### Agents (`.claude/agents/`)

- **code-reviewer**: reviews uncommitted changes. Read-only; every finding
  must come with a concrete failure scenario. The `bash-guard.sh review`
  hook allows only an exact list of commands (`git status`, `diff`,
  `ls-files`, `log`, `branch` with fixed flags, `pnpm lint`,
  `pnpm typecheck`); pipes, redirection, substitution and extra flags
  are blocked. Tests: `node --test "tests/hooks/*.test.mjs"`.
- **test-writer**: writes and runs Vitest tests. The `test-files-only.sh`
  hook lets it edit **only** test files; shared configs, setup files and
  application code are off limits. `bash-guard.sh test` adds
  `pnpm exec vitest run`, alone or with explicit test file paths.
- **docs-explorer**: looks up documentation for the installed versions
  (Context7 first, then official sites).

### Skills (`.claude/skills/`)

- `/bootstrap`: creates and configures a project (manual invocation only).
- `web-security`: checklist for auth, sessions, uploads, webhooks, CSP.
- `a11y-audit`: audits a page or flow against WCAG 2.2 AA.
- `browser-apis`: browser APIs: compatibility, fallbacks, permissions, cleanup.

### Hooks

Project-wide, in `.claude/settings.json`:

| Event        | Script           | What it does                                     |
| ------------ | ---------------- | ------------------------------------------------ |
| after Edit   | `format.sh`      | Prettier + `eslint --fix` on the edited file     |
| before Bash  | `block-push.sh`  | additionally blocks `git push`                   |
| Stop         | `stop-check.sh`  | `pnpm typecheck` when TS files changed           |

Per subagent, in the agent's frontmatter:

| Agent           | Event       | Script                | What it does                                       |
| --------------- | ----------- | --------------------- | -------------------------------------------------- |
| `code-reviewer` | before Bash | `bash-guard.sh review` | exact-command allowlist (git read-only, lint, typecheck) |
| `test-writer`   | before Bash | `bash-guard.sh test`  | same list plus `pnpm exec vitest run [test files]` |
| `test-writer`   | before Edit | `test-files-only.sh`  | edits only test files, helpers and fixtures; symlinks are resolved |

Blocking hooks exit with code 2, including when they fail (for example,
`node` is missing), so a broken hook never lets a command through.
Tests: `node --test "tests/hooks/*.test.mjs"`.

## Security model

Protection is built from several independent layers, so a mistake in one
does not open access:

1. **Permissions** (`permissions`):
   - installing or updating packages, `npm`/`npx`/`yarn`,
     `git commit`/`push`/`reset`/`rebase` and `rm -r` are denied;
   - reading `.env*`, keys and certificates, `~/.ssh` and `~/.aws` is denied;
   - changes to configs, `package.json`, `CLAUDE.md` and `.claude/` require
     confirmation;
   - `bypassPermissions` mode is disabled.
2. **Sandbox**: Bash runs in OS-level isolation; writes to configs, `.git`
   and `.claude` are blocked; network access is limited to Google Fonts
   (for `next/font`); `VERCEL_TOKEN`, `GITHUB_TOKEN` and `NPM_TOKEN` are not
   passed to commands.
3. **Hooks**: restrict what subagents can do, independent of their prompts.

Commits, pushes and dependency installs are always done by a human.

### Why `denyWrite` lists paths twice

`sandbox.filesystem.denyWrite` contains both wildcard entries
(`./*.config.*`, `./tsconfig*.json`) and the concrete files they match
(`./next.config.ts`, `./tsconfig.json`, …). This is intentional.

Wildcards in `allowWrite`/`denyWrite` work on macOS, but on Linux and WSL2
the sandbox mounts concrete paths, so any entry containing `*`, `?` or `[`
is skipped there and has no effect. The wildcards cover config files we
did not anticipate on macOS; the explicit paths keep the known configs
protected on every platform. When a project adds a new config file, add
its exact path to `denyWrite` too.

`denyRead` does not need this: wildcards work there on every platform.
Claude Code also adds every `Read(...)` rule from `permissions.deny` to the
sandbox's `denyRead`, so the `.env*` rules there protect Bash as well,
including in subdirectories of a monorepo.
`.env` variants are listed explicitly rather than as `.env.*` so that
`.env.example` stays readable.

Reference: [Sandbox path prefixes](https://code.claude.com/docs/en/settings-reference#sandbox-path-prefixes).

## Changing the starter

- `.claude/` and `CLAUDE.md` are protected: you confirm changes manually.
- After a major Next.js, React or Tailwind release, review the blocks
  marked `Version-specific`.
- Rules should contain only what is specific to the project or version.
  General advice the model already follows only takes up context.
