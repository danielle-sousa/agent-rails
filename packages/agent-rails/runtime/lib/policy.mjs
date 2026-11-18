import { matches, toProjectPath } from './glob.mjs';

/** @typedef {import('./config.mjs').RailsConfig} RailsConfig */
/** @typedef {import('./payload.mjs').NormalizedPayload} NormalizedPayload */

/**
 * Decides whether a tool call may run. Pure function: no I/O, easy to test.
 * @param {NormalizedPayload} payload
 * @param {RailsConfig} config
 * @returns {{ allow: boolean, reason?: string }}
 */
export function evaluatePreTool(payload, config) {
  if (payload.toolKind === 'edit') {
    for (const filePath of payload.filePaths) {
      const projectPath = toProjectPath(filePath, config.projectRoot);

      if (projectPath.startsWith('..')) {
        return deny(`agent-rails: "${filePath}" is outside the project. Edits are limited to this repository.`);
      }
      const rule = config.protectedPaths.find((p) => matches(projectPath, p.pattern));
      if (rule) {
        return deny(`agent-rails: "${projectPath}" is protected (${rule.reason}). Ask a human to change it, or explain why it needs to change.`);
      }
    }
  }

  if (payload.toolKind === 'read') {
    for (const filePath of payload.filePaths) {
      const projectPath = toProjectPath(filePath, config.projectRoot);
      const rule = config.protectedPaths.find((p) => p.blockRead && matches(projectPath, p.pattern));
      if (rule) {
        return deny(`agent-rails: "${projectPath}" cannot be read by the agent (${rule.reason}).`);
      }
    }
  }

  if (payload.toolKind === 'shell' && payload.command) {
    const rule = config.blockedCommands.find((c) => new RegExp(c.pattern).test(payload.command));
    if (rule) {
      return deny(`agent-rails: command blocked (${rule.reason}). Command: ${payload.command}`);
    }
  }

  return { allow: true };
}

/** @param {string} reason */
function deny(reason) {
  return { allow: false, reason };
}

/**
 * Which edited files each file-level check should look at.
 * @param {string[]} filePaths
 * @param {RailsConfig} config
 */
export function filesForChecks(filePaths, config) {
  const projectPaths = filePaths
    .map((f) => toProjectPath(f, config.projectRoot))
    .filter((p) => !p.startsWith('..'));

  return config.fileChecks
    .map((check) => ({
      check,
      files: projectPaths.filter((p) => (check.extensions ?? []).some((ext) => p.endsWith(ext))),
    }))
    .filter((entry) => entry.files.length > 0);
}
