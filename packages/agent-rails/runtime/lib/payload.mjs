// Normalizes hook payloads from Claude Code, GitHub Copilot and Cursor
// into a single shape the policies can reason about.
//
// Each agent sends a different JSON on stdin:
//   Claude Code  -> { hook_event_name, tool_name, tool_input, stop_hook_active, session_id }
//   Copilot      -> { sessionId, toolName, toolArgs, stop_hook_active }  (camelCase events)
//   Cursor       -> { hook_event_name, tool_name, tool_input, file_path, loop_count, workspace_roots }
//
// The rest of agent-rails only sees `NormalizedPayload`.

/**
 * @typedef {'claude' | 'copilot' | 'cursor'} AgentId
 * @typedef {'edit' | 'shell' | 'read' | 'other'} ToolKind
 *
 * @typedef {object} NormalizedPayload
 * @property {AgentId} agent
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} toolName      Original tool name, as the agent reported it.
 * @property {ToolKind} toolKind
 * @property {string[]} filePaths   Files the tool call touches (best effort).
 * @property {string | null} command Shell command, when the tool is a shell.
 * @property {boolean} continuing   True when the agent is already running because a stop gate blocked it.
 * @property {number} loopCount     How many times the stop gate already sent the agent back (Cursor only).
 * @property {string} stopStatus    'completed' unless the agent reports otherwise.
 */

const EDIT_TOOLS = new Set([
  // Claude Code
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  // GitHub Copilot (CLI, cloud agent, VS Code)
  'edit', 'create', 'str_replace_editor', 'apply_patch', 'editFiles', 'createFile', 'replace_string_in_file', 'create_file',
  // Cursor
  'Delete',
]);

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'powershell', 'Shell', 'run_in_terminal', 'runInTerminal']);
const READ_TOOLS = new Set(['Read', 'read', 'view', 'read_file', 'Grep', 'Glob', 'grep', 'glob']);

/** @param {unknown} raw */
export function detectAgent(raw) {
  if (!raw || typeof raw !== 'object') return 'claude';
  const p = /** @type {Record<string, unknown>} */ (raw);
  if ('workspace_roots' in p || 'conversation_id' in p || 'loop_count' in p) return 'cursor';
  if ('toolName' in p || 'toolArgs' in p || 'sessionId' in p || 'stopReason' in p) return 'copilot';
  return 'claude';
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

/** @param {string} toolName */
export function classifyTool(toolName) {
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (READ_TOOLS.has(toolName)) return 'read';
  // Cursor reports Write for both creating and editing files.
  if (toolName === 'Write') return 'edit';
  return 'other';
}

/**
 * apply_patch sends a unified patch instead of a path.
 * @param {string} patch
 */
function pathsFromPatch(patch) {
  const paths = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let match;
  while ((match = re.exec(patch)) !== null) paths.push(match[1].trim());
  return paths;
}

/** @param {Record<string, any>} input */
function extractPaths(input) {
  const candidates = [input.file_path, input.filePath, input.path, input.target_file, input.notebook_path];
  /** @type {string[]} */
  const paths = candidates.filter((c) => typeof c === 'string' && c.length > 0);

  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (typeof edit?.file_path === 'string') paths.push(edit.file_path);
      if (typeof edit?.path === 'string') paths.push(edit.path);
    }
  }
  if (Array.isArray(input.files)) {
    for (const file of input.files) if (typeof file === 'string') paths.push(file);
  }
  for (const key of ['patch', 'input', 'raw']) {
    if (typeof input[key] === 'string' && input[key].includes('*** ')) paths.push(...pathsFromPatch(input[key]));
  }
  return [...new Set(paths)];
}

/**
 * @param {unknown} raw  Parsed stdin.
 * @param {AgentId | undefined} forcedAgent  Value of --agent, when the adapter passes one.
 * @returns {NormalizedPayload}
 */
export function normalize(raw, forcedAgent) {
  const p = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
  const agent = forcedAgent ?? detectAgent(p);

  const toolName = String(p.tool_name ?? p.toolName ?? '');
  const toolInput = /** @type {Record<string, any>} */ (parseMaybeJson(p.tool_input ?? p.toolArgs));

  const filePaths = extractPaths(toolInput);
  // Cursor's afterFileEdit puts the path at the top level.
  if (typeof p.file_path === 'string') filePaths.push(p.file_path);

  const cwd = String(p.cwd ?? (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : undefined) ?? process.cwd());

  return {
    agent,
    sessionId: String(p.session_id ?? p.sessionId ?? p.conversation_id ?? 'unknown'),
    cwd,
    toolName,
    toolKind: toolName ? classifyTool(toolName) : 'other',
    filePaths: [...new Set(filePaths)],
    command: typeof toolInput.command === 'string' ? toolInput.command : null,
    continuing: Boolean(p.stop_hook_active),
    loopCount: Number(p.loop_count ?? 0),
    stopStatus: String(p.status ?? 'completed'),
  };
}
