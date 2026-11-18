import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Small JSON state file under .agent-rails/.state (git-ignored).
// It answers three questions the agents don't answer for us:
//   1. Did this exact hook call already run a moment ago? (some editors read
//      more than one hook file, so the same event can fire twice)
//   2. How many times did the stop gate already send this session back?
//   3. Has the current set of changes already passed the gate?

const DEDUPE_WINDOW_MS = 10_000;

/** @param {string} stateDir */
function stateFile(stateDir) {
  return path.join(stateDir, 'state.json');
}

/** @param {string} stateDir */
export function readState(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8'));
  } catch {
    return { seen: {}, retries: {}, lastGreen: null };
  }
}

/** @param {string} stateDir @param {object} state */
export function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile(stateDir), JSON.stringify(state, null, 2));
}

/** @param {unknown} value */
export function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Returns true when an identical call was handled within the dedupe window,
 * and records the current call otherwise.
 * @param {string} stateDir
 * @param {string} key
 */
export function isDuplicate(stateDir, key, now = Date.now()) {
  const state = readState(stateDir);
  const seen = Object.fromEntries(
    Object.entries(state.seen ?? {}).filter(([, at]) => now - Number(at) < DEDUPE_WINDOW_MS),
  );
  const duplicate = key in seen;
  seen[key] = now;
  writeState(stateDir, { ...state, seen });
  return duplicate;
}

/** @param {string} stateDir @param {string} sessionId */
export function getRetries(stateDir, sessionId) {
  return Number(readState(stateDir).retries?.[sessionId] ?? 0);
}

/** @param {string} stateDir @param {string} sessionId @param {number} value */
export function setRetries(stateDir, sessionId, value) {
  const state = readState(stateDir);
  writeState(stateDir, { ...state, retries: { ...state.retries, [sessionId]: value } });
}

/** @param {string} stateDir */
export function getLastGreen(stateDir) {
  return readState(stateDir).lastGreen ?? null;
}

/** @param {string} stateDir @param {string | null} hash */
export function setLastGreen(stateDir, hash) {
  writeState(stateDir, { ...readState(stateDir), lastGreen: hash });
}
