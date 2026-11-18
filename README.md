# agent-rails 🛤️

**A frontend harness for AI coding agents.** One set of guardrails for Claude Code, GitHub Copilot and Cursor, tuned for Angular workspaces.

Instructions files (`AGENTS.md`, `CLAUDE.md`, Cursor rules) tell an agent how the team works. They are context, not enforcement: the agent can still edit `.env`, loosen the lint config, add a dependency or stop with failing tests. `agent-rails` moves the rules that must hold into **hooks**, which the agent's runtime executes deterministically, and keeps the guidance that only needs to inform in **instructions and skills**.

```
                ┌──────────────────────────────────────────────┐
                │  AGENTS.md + skills       → what to do        │  guidance (the model decides)
                │  Angular CLI MCP          → how to do it      │
                ├──────────────────────────────────────────────┤
 agent wants →  │  guard  (before a tool)   → may it run?       │
 to act         │  check  (after an edit)   → is the file OK?   │  enforcement (the harness decides)
                │  gate   (before stopping) → is the task done? │
                └──────────────────────────────────────────────┘
```

## What it enforces

| Moment | Check | Example |
| --- | --- | --- |
| Before a tool runs (`guard`) | Protected paths | No edits to `.env*`, `angular.json`, `package-lock.json`, `eslint.config.js`, the harness itself |
| | Secrets | No reading `.env*` |
| | Shell commands | No `git push`, `rm -rf`, `npm install <new-package>`, `curl … \| sh` |
| After a file edit (`check`) | ESLint + template accessibility | `click` on a `div` without keyboard support is reported back to the model on the same turn |
| | Design tokens | Raw `#hex` / `rgb()` in component styles → use `var(--…)` |
| | No suppressions | `eslint-disable`, `@ts-ignore` are rejected |
| Before the agent stops (`gate`) | Typecheck, lint, unit tests | If anything fails, the agent is sent back to work with the failure output (bounded retries) |

Everything is configured in [`.agent-rails/rails.config.json`](packages/agent-rails/runtime/rails.config.json).

## One core, three adapters

Each agent sends a different JSON on stdin and expects a different answer. The runtime normalizes the payload, applies the same policy, and answers in the caller's dialect:

| | Claude Code | GitHub Copilot | Cursor |
| --- | --- | --- | --- |
| Hook file | `.claude/settings.json` | `.github/hooks/agent-rails.json` | `.cursor/hooks.json` |
| Before a tool | `PreToolUse` → `hookSpecificOutput.permissionDecision` | `preToolUse` → `permissionDecision` | `preToolUse` → `permission` |
| After an edit | `PostToolUse` → `decision` + `additionalContext` | `postToolUse` → `additionalContext` | `postToolUse` → `additional_context` |
| Before stopping | `Stop` → `decision: "block"` | `agentStop` → `decision: "block"` | `stop` → `followup_message` |
| Instructions | `CLAUDE.md` → `@AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| Skills | `.claude/skills/` | `.claude/skills/` | `.claude/skills/` |
| Reviewer subagent | `.claude/agents/` | `.github/agents/` | `.cursor/agents/` |
| MCP (Angular CLI) | `.mcp.json` | `.vscode/mcp.json` | `.cursor/mcp.json` |

The runtime always answers with JSON and exit code `0`. Exit code `2` means "deny" in a pre-tool hook, "warning" in a Copilot post-tool hook and "keep working" in a Claude stop hook, so relying on it would make the same script behave differently per agent.

Some editors read more than one hook file (VS Code's Copilot harness also reads `.claude/settings.json`). The runtime deduplicates identical calls, so a check runs once even when two adapters fire.

## Install

```bash
npx agent-rails init            # all three agents
npx agent-rails init --tools claude,cursor
```

The runtime is copied into `.agent-rails/` (zero dependencies, plain Node ≥ 20) so it is versioned and reviewed with the project: no network calls, nothing resolved at runtime. Existing files are never overwritten; `rails.config.json` survives `--force`.

## See it work

[`examples/angular-demo`](examples/angular-demo) is an Angular 22 app with the harness installed. Replay an agent session against it:

```bash
cd examples/angular-demo && npm ci && cd ..
node simulate-session.mjs
```

The script feeds real hook payloads from each agent (reading `.env`, loosening the lint config, adding a dependency, replacing a `button` with a clickable `div`, hardcoding a color, silencing ESLint, stopping with a failing test) and prints what the harness answers.

## Limits

- **Hooks see tool calls, not intent.** A shell command that writes to a protected file (`echo … > .env`) is not parsed. Keep the blocked command list short and pair it with OS and CI permissions.
- **Hook APIs move fast.** Payload shapes are normalized defensively, but each agent's hook system is still evolving. The test suite pins the payloads this version understands.
- **The gate trades time for confidence.** Typecheck + lint + tests run when the agent stops, and only when watched files changed. Large workspaces should point the gate at affected projects.
- **Cloud agents are a different environment.** Copilot's cloud agent and Cursor's cloud agents run repository hooks in their own VMs; agents with their own closed harness cannot be configured this way at all.
- **This is not a security boundary.** It reduces the blast radius of a well-meaning agent. Secrets, production credentials and deploys still need real access control.

## Repository layout

```
packages/agent-rails/
  bin/agent-rails.mjs     installer (init)
  runtime/                copied into <project>/.agent-rails
    bin/rails.mjs         entry point: guard | check | gate
    lib/payload.mjs       normalizes Claude / Copilot / Cursor payloads
    lib/policy.mjs        pure decisions (testable without I/O)
    lib/output.mjs        answers in each agent's dialect
    lib/checks.mjs        command checks + built-ins (design tokens, suppressions)
    rails.config.json     default policy for Angular
  templates/              AGENTS.md, skills, subagents, hook and MCP adapters
  test/                   node:test suite with payload fixtures per agent
examples/
  angular-demo/           Angular 22 app with agent-rails installed
  simulate-session.mjs    replays an agent session against the demo
```

## License

MIT © Danielle Sousa Koscak
