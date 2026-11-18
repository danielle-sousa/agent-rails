#!/usr/bin/env node
// agent-rails runtime entry point. Every agent adapter calls this script:
//
//   node .agent-rails/bin/rails.mjs <guard|check|gate> [--agent claude|copilot|cursor]
//
//   guard  before a tool runs   → blocks protected files and dangerous commands
//   check  after a file edit    → lint / a11y / design tokens on the edited files
//   gate   when the agent stops → typecheck, lint and tests on everything that changed
//
// The hook payload arrives on stdin. The answer goes to stdout, in the dialect
// of the agent that called us.

import { runCheck, changedFiles } from '../lib/checks.mjs';
import { loadConfig } from '../lib/config.mjs';
import { postToolResponse, preToolResponse, stopResponse } from '../lib/output.mjs';
import { normalize } from '../lib/payload.mjs';
import { evaluatePreTool, filesForChecks } from '../lib/policy.mjs';
import { fingerprint, getLastGreen, getRetries, isDuplicate, setLastGreen, setRetries } from '../lib/state.mjs';

const AGENTS = new Set(['claude', 'copilot', 'cursor']);

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const agentIndex = rest.indexOf('--agent');
  const agent = agentIndex >= 0 ? rest[agentIndex + 1] : undefined;
  return { command, agent: AGENTS.has(agent) ? agent : undefined };
}

/** @param {{ stdout: string, exitCode: number }} response */
function respond(response) {
  if (response.stdout) process.stdout.write(`${response.stdout}\n`);
  process.exit(response.exitCode);
}

function guard(payload, config) {
  return preToolResponse(payload.agent, evaluatePreTool(payload, config));
}

function check(payload, config) {
  if (payload.toolKind !== 'edit' && payload.filePaths.length === 0) return postToolResponse(payload.agent, null);

  const key = fingerprint(['check', payload.filePaths]);
  if (isDuplicate(config.stateDir, key)) return postToolResponse(payload.agent, null);

  const failures = filesForChecks(payload.filePaths, config)
    .map(({ check: c, files }) => runCheck(c, files, config))
    .filter((result) => !result.ok);

  if (failures.length === 0) return postToolResponse(payload.agent, null);

  const report = failures.map((f) => `[${f.name}]\n${f.output}`).join('\n\n');
  return postToolResponse(
    payload.agent,
    `agent-rails found problems in the file you just edited. Fix them before moving on:\n\n${report}`,
  );
}

function gate(payload, config) {
  if (payload.stopStatus !== 'completed') return stopResponse(payload.agent, null);

  const { files, hash } = changedFiles(config);
  // Nothing under watch changed (a question, a read-only task): let the agent stop.
  if (hash !== null && files.length === 0) return stopResponse(payload.agent, null);
  // These exact changes already passed the gate.
  if (hash !== null && hash === getLastGreen(config.stateDir)) return stopResponse(payload.agent, null);

  // Some editors load more than one hook file; run the gate once per change set.
  if (isDuplicate(config.stateDir, fingerprint(['gate', payload.sessionId, hash]))) return stopResponse(payload.agent, null);

  const retries = Math.max(getRetries(config.stateDir, payload.sessionId), payload.loopCount);
  if (retries >= config.gate.maxRetries) {
    setRetries(config.stateDir, payload.sessionId, 0);
    // Give up on the loop, but never silently: the human sees why.
    process.stderr.write(`agent-rails: gate still failing after ${retries} attempts. Handing control back to you.\n`);
    return stopResponse(payload.agent, null);
  }

  const failures = config.gate.checks
    .map((c) => {
      const scoped = c.extensions ? files.filter((f) => c.extensions.some((ext) => f.endsWith(ext))) : files;
      return runCheck(c, scoped, config);
    })
    .filter((result) => !result.ok);

  if (failures.length === 0) {
    setRetries(config.stateDir, payload.sessionId, 0);
    setLastGreen(config.stateDir, hash);
    return stopResponse(payload.agent, null);
  }

  setRetries(config.stateDir, payload.sessionId, retries + 1);
  const report = failures.map((f) => `[${f.name}]\n${f.output}`).join('\n\n');
  return stopResponse(
    payload.agent,
    `agent-rails gate failed (attempt ${retries + 1} of ${config.gate.maxRetries}). ` +
      `The task is not done until these pass:\n\n${report}`,
  );
}

const HANDLERS = { guard, check, gate };

async function main() {
  const { command, agent } = parseArgs(process.argv.slice(2));
  const handler = HANDLERS[command];
  if (!handler) {
    process.stderr.write('Usage: rails.mjs <guard|check|gate> [--agent claude|copilot|cursor]\n');
    process.exit(1);
  }

  const payload = normalize(await readStdin(), agent);
  const config = loadConfig();
  respond(handler(payload, config));
}

main().catch((error) => {
  // Fail loudly but don't take the agent down with us. Note: Copilot treats a
  // crashing preToolUse hook as a deny (fail-closed); Claude and Cursor fail open.
  process.stderr.write(`agent-rails internal error: ${error?.stack ?? error}\n`);
  process.exit(1);
});
