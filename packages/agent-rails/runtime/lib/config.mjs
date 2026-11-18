import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The runtime lives in <project>/.agent-rails/lib, so the project root is two levels up.
const RUNTIME_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @typedef {object} ProtectedPath
 * @property {string} pattern
 * @property {string} reason
 * @property {boolean} [blockRead]  Also stop the agent from reading the file (secrets).
 *
 * @typedef {object} BlockedCommand
 * @property {string} pattern   Regular expression, tested against the full command.
 * @property {string} reason
 *
 * @typedef {object} Check
 * @property {string} name
 * @property {string} [command]   Shell command. "{files}" is replaced by the files being checked.
 * @property {string} [builtin]   Name of a built-in check (see checks.mjs).
 * @property {string[]} [extensions]  File checks only: which files the check applies to.
 *
 * @typedef {object} RailsConfig
 * @property {string} projectRoot
 * @property {string} stateDir
 * @property {ProtectedPath[]} protectedPaths
 * @property {BlockedCommand[]} blockedCommands
 * @property {Check[]} fileChecks
 * @property {{ checks: Check[], watch: string[], maxRetries: number }} gate
 * @property {{ tokensFile: string, scope: string[] }} designTokens
 */

/** @returns {RailsConfig} */
export function loadConfig(runtimeDir = RUNTIME_DIR) {
  const file = path.join(runtimeDir, 'rails.config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const projectRoot = path.resolve(runtimeDir, raw.projectRoot ?? '..');

  return {
    projectRoot,
    stateDir: path.join(runtimeDir, '.state'),
    protectedPaths: raw.protectedPaths ?? [],
    blockedCommands: raw.blockedCommands ?? [],
    fileChecks: raw.fileChecks ?? [],
    gate: {
      checks: raw.gate?.checks ?? [],
      watch: raw.gate?.watch ?? ['src/**'],
      maxRetries: raw.gate?.maxRetries ?? 2,
    },
    designTokens: {
      tokensFile: raw.designTokens?.tokensFile ?? 'src/styles/_tokens.scss',
      scope: raw.designTokens?.scope ?? ['src/app/**'],
    },
  };
}
