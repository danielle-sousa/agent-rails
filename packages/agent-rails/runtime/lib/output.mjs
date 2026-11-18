// Translates an agent-rails decision back into the dialect each agent understands.
//
// Every function returns { stdout, exitCode }. The CLI prints stdout and exits.
// We always answer with JSON + exit 0 instead of relying on exit code 2,
// because exit 2 means different things in each agent (deny in a pre hook,
// "warning" in a Copilot post hook, "keep working" in a Claude stop hook).

/** @typedef {import('./payload.mjs').AgentId} AgentId */
/** @typedef {{ stdout: string, exitCode: number }} HookResponse */

const ok = (body) => ({ stdout: body === undefined ? '' : JSON.stringify(body), exitCode: 0 });

/**
 * Pre-tool decision.
 * @param {AgentId} agent
 * @param {{ allow: boolean, reason?: string }} decision
 * @returns {HookResponse}
 */
export function preToolResponse(agent, { allow, reason = '' }) {
  if (agent === 'cursor') {
    // Cursor treats invalid or empty JSON in permission hooks as a block, so always answer.
    return ok(allow ? { permission: 'allow' } : { permission: 'deny', agent_message: reason, user_message: reason });
  }
  if (allow) return ok();
  if (agent === 'copilot') {
    return ok({ permissionDecision: 'deny', permissionDecisionReason: reason });
  }
  return ok({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Post-tool feedback: the tool already ran, so the best we can do is
 * put the problem in front of the model on the same turn.
 * @param {AgentId} agent
 * @param {string | null} feedback  null when every check passed.
 * @returns {HookResponse}
 */
export function postToolResponse(agent, feedback) {
  if (!feedback) return agent === 'cursor' ? ok({}) : ok();
  if (agent === 'cursor') return ok({ additional_context: feedback });
  if (agent === 'copilot') return ok({ additionalContext: feedback });
  return ok({
    decision: 'block',
    reason: feedback,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: feedback },
  });
}

/**
 * Stop gate: either let the agent finish or send it back to work.
 * @param {AgentId} agent
 * @param {string | null} followUp  null lets the agent stop.
 * @returns {HookResponse}
 */
export function stopResponse(agent, followUp) {
  if (!followUp) return agent === 'cursor' ? ok({}) : ok();
  if (agent === 'cursor') return ok({ followup_message: followUp });
  // Claude Code and Copilot share the same contract for this event.
  return ok({ decision: 'block', reason: followUp });
}
