import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { matches } from './glob.mjs';

/** @typedef {import('./config.mjs').RailsConfig} RailsConfig */
/** @typedef {import('./config.mjs').Check} Check */
/** @typedef {{ name: string, ok: boolean, output: string }} CheckResult */

const MAX_OUTPUT = 4000;

/**
 * Tools print progress first and failures last, so keep the tail.
 * @param {string} text
 */
function trim(text) {
  const clean = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    // Drop build tables and progress noise; the model needs the failure, not the bundle size.
    .filter((line) => !/^\s*(❯ Building|✔ Building|Initial (chunk|total)|.*\|\s+[\d.]+ (kB|bytes)|Application bundle generation)/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > MAX_OUTPUT ? `… (output truncated)\n${clean.slice(-MAX_OUTPUT)}` : clean;
}

/** @param {string} file */
const quote = (file) => `"${file.replace(/"/g, '\\"')}"`;

/**
 * Built-in check: component styles must use design tokens, not raw colors.
 * Raw hex/rgb/hsl values are allowed only in the tokens file.
 * @param {string[]} files
 * @param {RailsConfig} config
 * @returns {CheckResult}
 */
export function designTokensCheck(files, config) {
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;
  const problems = [];

  for (const file of files) {
    if (file === config.designTokens.tokensFile) continue;
    if (!config.designTokens.scope.some((glob) => matches(file, glob))) continue;

    const absolute = path.join(config.projectRoot, file);
    if (!fs.existsSync(absolute)) continue;

    fs.readFileSync(absolute, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        const found = line.match(colorLiteral);
        if (found) problems.push(`${file}:${index + 1}  raw color ${found.join(', ')} → use a token from ${config.designTokens.tokensFile}`);
      });
  }

  return { name: 'design-tokens', ok: problems.length === 0, output: problems.join('\n') };
}

/**
 * Built-in check: the agent must fix problems, not silence the tools that report them.
 * @param {string[]} files
 * @param {RailsConfig} config
 * @returns {CheckResult}
 */
export function suppressionsCheck(files, config) {
  const suppression = /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error/;
  const problems = [];

  for (const file of files) {
    const absolute = path.join(config.projectRoot, file);
    if (!fs.existsSync(absolute)) continue;
    fs.readFileSync(absolute, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const found = line.match(suppression);
        if (found) problems.push(`${file}:${index + 1}  "${found[0]}" silences a check. Fix the underlying problem instead.`);
      });
  }

  return { name: 'no-suppressions', ok: problems.length === 0, output: problems.join('\n') };
}

const BUILTINS = { 'design-tokens': designTokensCheck, 'no-suppressions': suppressionsCheck };

/**
 * @param {Check} check
 * @param {string[]} files  Project-relative paths (may be empty for project-wide checks).
 * @param {RailsConfig} config
 * @returns {CheckResult}
 */
export function runCheck(check, files, config) {
  if (check.builtin) {
    const builtin = BUILTINS[check.builtin];
    if (!builtin) return { name: check.name, ok: false, output: `Unknown built-in check "${check.builtin}"` };
    return builtin(files, config);
  }

  const command = (check.command ?? '').replace('{files}', files.map(quote).join(' '));
  const result = spawnSync(command, {
    cwd: config.projectRoot,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    name: check.name,
    ok: result.status === 0,
    output: trim(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
  };
}

/**
 * Lists files changed in the working tree that fall under the gate's watch globs,
 * plus a hash of their current content so we can skip a gate that already passed.
 * @param {RailsConfig} config
 * @returns {{ files: string[], hash: string | null }}
 */
export function changedFiles(config) {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: config.projectRoot,
    encoding: 'utf8',
  });
  if (status.status !== 0) return { files: [], hash: null };

  const files = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop().trim())
    .map((file) => path.relative(config.projectRoot, path.join(gitRoot(config), file)).split(path.sep).join('/'))
    .filter((file) => config.gate.watch.some((glob) => matches(file, glob)));

  const hasher = spawnSync('git', ['hash-object', '--stdin-paths'], {
    cwd: config.projectRoot,
    input: files.filter((f) => fs.existsSync(path.join(config.projectRoot, f))).join('\n'),
    encoding: 'utf8',
  });

  return { files, hash: files.length ? `${files.join('|')}::${hasher.stdout.replace(/\s+/g, '')}` : null };
}

/** @param {RailsConfig} config */
function gitRoot(config) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: config.projectRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : config.projectRoot;
}
