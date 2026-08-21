#!/usr/bin/env node

/**
 * Claude State — Hecaton Plugin v1.4.0
 *
 * Detects AI agent state (Claude, Gemini, Codex, OpenCode, etc.)
 * and displays real-time status badges and notifications on terminal tabs.
 *
 * 2-tier detection:
 *   Tier 1 (Hook): Receives hook events via WebSocket/HTTP -> immediate state transition
 *   Tier 2 (Pattern): Terminal content pattern matching -> transition after 2 consecutive matches
 *
 * Hook protocol (WebSocket text or HTTP POST /hook):
 *   { "client": "claude", "terminal_id": 1, "event": "AfterAgent", ... }
 *
 * Notifications are per-event opt-in (see NOTIFY_EVENTS). Events that fire
 * mid-turn — PermissionRequest, SessionStart on resume/compact — are off by
 * default so a notification means the turn actually ended.
 *
 * Driven by mouse: every row is a toggle, buttons sit on the right, the wheel
 * scrolls the log, and right-click opens the full menu. Precise mouse events
 * are used when the host offers them, with SGR on stdin as the fallback.
 *
 * Keys (kept as a shortcut, not the primary path):
 *   s=toggle server  p=toggle pattern  n=cycle preset  c=clear log  q/ESC=quit
 */

// ============================================================
// Agent Patterns (inline — no ES module import)
// ============================================================
const AGENT_PATTERNS = {
  claude: {
    busy: ["ctrl+c to interrupt", "esc to interrupt"],
    busyRe: [/[✳✽✶✻✢·]\s*.+…/],
    prompt: ["$ "],
    promptRe: [/[❯>]\s*$/],
    detect: ["ctrl+c to interrupt", "Claude Code"],
    detectRe: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\w+…/],
    spinner: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳✽✶✻✢".split(""),
  },
  gemini: {
    busy: ["esc to cancel"], busyRe: [],
    prompt: ["gemini>", "Type your message"], promptRe: [],
    detect: ["gemini>", "esc to cancel"], detectRe: [],
    spinner: [],
  },
  codex: {
    busy: ["ctrl+c to interrupt"], busyRe: [],
    prompt: ["codex>"], promptRe: [],
    detect: ["codex>", "codex "], detectRe: [],
    spinner: [],
  },
  opencode: {
    busy: ["thinking...", "generating...", "esc interrupt"], busyRe: [],
    prompt: ["Ask anything", "press enter to send"], promptRe: [],
    detect: ["opencode", "Ask anything"], detectRe: [],
    spinner: [],
  },
  aider: {
    busy: [], busyRe: [/Tokens:\s+\d+/],
    prompt: [], promptRe: [/aider\s*>/i],
    detect: ["aider"], detectRe: [/aider\s*>/i],
    spinner: [],
  },
};

function matchLine(line, strings, regexps) {
  for (const s of strings) { if (line.includes(s)) return true; }
  for (const re of regexps) { if (re.test(line)) return true; }
  return false;
}

function detectAgent(lines) {
  for (const [agent, pat] of Object.entries(AGENT_PATTERNS)) {
    for (const line of lines) {
      if (matchLine(line, pat.detect, pat.detectRe || [])) return agent;
    }
  }
  return null;
}

function isBusy(lines, agent) {
  const pat = AGENT_PATTERNS[agent];
  if (!pat) return false;
  for (const line of lines) {
    if (matchLine(line, pat.busy, pat.busyRe || [])) return true;
  }
  if (pat.spinner && pat.spinner.length > 0) {
    const tail = lines.slice(-3);
    for (const line of tail) {
      for (const ch of pat.spinner) { if (line.includes(ch)) return true; }
    }
  }
  return false;
}

function isPrompt(lines, agent) {
  const pat = AGENT_PATTERNS[agent];
  if (!pat) return false;
  const tail = lines.slice(-3);
  for (const line of tail) {
    if (matchLine(line, pat.prompt, pat.promptRe || [])) return true;
  }
  return false;
}

// ============================================================
// State Machine (inline)
// ============================================================
class AgentStateMachine {
  constructor() {
    this.terminals = new Map();
    this.onTransition = null;
  }

  _get(terminalId) {
    if (!this.terminals.has(terminalId)) {
      this.terminals.set(terminalId, {
        state: null, agent: null, model: null, sessionId: null,
        lastTransition: 0, acknowledged: false,
        pendingState: null, pendingCount: 0,
      });
    }
    return this.terminals.get(terminalId);
  }

  setFromHook(terminalId, state, info = {}) {
    const ts = this._get(terminalId);
    const oldState = ts.state;
    ts.agent = info.agent || ts.agent;
    ts.model = info.model || ts.model;
    ts.sessionId = info.sessionId || ts.sessionId;
    ts.pendingState = null;
    ts.pendingCount = 0;

    if (state === "dead" || state === "end") {
      this.terminals.delete(terminalId);
      if (oldState && this.onTransition) {
        this.onTransition(terminalId, oldState, null, { agent: ts.agent, reason: "hook", ...info });
      }
      return;
    }
    if (oldState === state) return;
    ts.state = state;
    ts.lastTransition = Date.now();
    if (state === "waiting") ts.acknowledged = false;
    if (this.onTransition) {
      this.onTransition(terminalId, oldState, state, { agent: ts.agent, model: ts.model, reason: "hook", ...info });
    }
  }

  setFromPattern(terminalId, state, info = {}) {
    const ts = this._get(terminalId);
    ts.agent = info.agent || ts.agent;
    if (ts.state === state) { ts.pendingState = null; ts.pendingCount = 0; return; }
    if (ts.pendingState === state) {
      ts.pendingCount++;
      if (ts.pendingCount >= 2) {
        const oldState = ts.state;
        ts.state = state;
        ts.lastTransition = Date.now();
        ts.pendingState = null;
        ts.pendingCount = 0;
        if (state === "waiting") ts.acknowledged = false;
        if (this.onTransition) {
          this.onTransition(terminalId, oldState, state, { agent: ts.agent, reason: "pattern", ...info });
        }
      }
    } else {
      ts.pendingState = state;
      ts.pendingCount = 1;
    }
  }

  acknowledge(terminalId) {
    const ts = this.terminals.get(terminalId);
    if (ts && ts.state === "waiting" && !ts.acknowledged) ts.acknowledged = true;
  }

  getState(terminalId) { return this.terminals.get(terminalId) || null; }

  getAll() {
    return Array.from(this.terminals.entries()).map(([id, ts]) => ({ id, ...ts }));
  }

  remove(terminalId) { this.terminals.delete(terminalId); }
}

// ============================================================
// ANSI helpers
// ============================================================
const ESC = '\x1b';
const CSI = ESC + '[';
const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  moveTo: (r, c) => `${CSI}${r};${c}H`,
  inverse: CSI + '7m',
  fg: {
    red: CSI + '31m', green: CSI + '32m', yellow: CSI + '33m',
    cyan: CSI + '36m', white: CSI + '37m', gray: CSI + '90m',
    orange: CSI + '38;5;215m', pink: CSI + '38;5;212m',
  },
  bg: {
    green: CSI + '42m', orange: CSI + '48;5;215m', gray: CSI + '100m',
    hover: CSI + '48;2;58;58;70m',
  },
};

// Only characters already proven to render at width 1 in this overlay are used
// for controls — a double-width glyph would shift every click zone on its row
// out of alignment with what the user sees.
const MARK_ON = '●';
const MARK_OFF = '○';

// ============================================================
// Notification config (inline — persisted to plugin data dir)
// ============================================================
const CONFIG_VERSION = 1;

// Order here drives the settings screen: [1]..[n] map to these rows.
const NOTIFY_EVENTS = [
  { key: 'Stop', label: 'Stop', desc: 'turn complete' },
  { key: 'StopFailure', label: 'StopFailure', desc: 'turn ended with error' },
  { key: 'PermissionRequest', label: 'PermissionRequest', desc: 'permission prompt (mid-turn)' },
  { key: 'SessionStart', label: 'SessionStart', desc: 'session start / resume / clear' },
  { key: 'Idle', label: 'Idle', desc: 'idle prompt after 60s' },
];

const PRESETS = {
  strict: { Stop: true, StopFailure: false, PermissionRequest: false, SessionStart: false, Idle: false },
  normal: { Stop: true, StopFailure: true, PermissionRequest: false, SessionStart: false, Idle: false },
  all: { Stop: true, StopFailure: true, PermissionRequest: true, SessionStart: true, Idle: true },
};
const PRESET_ORDER = ['strict', 'normal', 'all'];

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  preset: 'normal',
  notify: { ...PRESETS.normal },
  suppressDuringCompact: true,
};

let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let configFile = null;

function presetNameFor(notify) {
  for (const name of PRESET_ORDER) {
    const p = PRESETS[name];
    if (NOTIFY_EVENTS.every(e => !!p[e.key] === !!notify[e.key])) return name;
  }
  return 'custom';
}

async function envValue(name) {
  try {
    const r = await hecaton.env.get({ name });
    return (r && r.value) ? r.value : null;
  } catch { return null; }
}

// Notification prefs are global, not per-project — prefer the shared data dir.
async function resolveConfigDir() {
  const shared = await envValue('HECA_PLUGIN_DATA_DIR');
  if (shared) return shared;
  const local = await envValue('HECA_PLUGIN_LOCAL_DATA_DIR');
  if (local) return local;
  try {
    const home = await hecaton.env.get_home();
    const path = home && (home.path || home.value);
    if (path) return `${path}/.hecaton/data/dev_hecaton_claude-hook`;
  } catch { /* ignore */ }
  return null;
}

async function initLogFile() {
  try {
    const home = await hecaton.env.get_home();
    const base = home && (home.path || home.value);
    if (!base) return;
    logFilePath = `${base}/.claude/hecaton-agent-state.log`;
    serverIdFile = `${base}/.claude/hecaton-agent-state.server`;
    addLog(`=== plugin start (port ${PORT}) — log: ${logFilePath}`);
  } catch { /* ignore */ }
}

async function loadConfig() {
  const dir = await resolveConfigDir();
  if (!dir) { addLog('Config dir unavailable — using defaults'); return; }
  configFile = `${dir}/config.json`;
  try {
    const result = await hecaton.fs.read_file({ path: configFile });
    if (!result || !result.content) return;
    const parsed = JSON.parse(result.content);
    if (!parsed || parsed.version !== CONFIG_VERSION) return;
    const notify = { ...DEFAULT_CONFIG.notify };
    if (parsed.notify && typeof parsed.notify === 'object') {
      for (const e of NOTIFY_EVENTS) {
        if (typeof parsed.notify[e.key] === 'boolean') notify[e.key] = parsed.notify[e.key];
      }
    }
    config = {
      version: CONFIG_VERSION,
      notify,
      preset: presetNameFor(notify),
      suppressDuringCompact: typeof parsed.suppressDuringCompact === 'boolean'
        ? parsed.suppressDuringCompact
        : DEFAULT_CONFIG.suppressDuringCompact,
    };
    addLog(`Config loaded (preset: ${config.preset})`);
  } catch {
    // Missing or corrupt file — defaults already in place
  }
}

async function saveConfig() {
  if (!configFile) return;
  try {
    const dir = configFile.replace(/\/[^/]*$/, '');
    await hecaton.fs.mkdir({ path: dir }).catch(() => null);
    await hecaton.fs.write_file({ path: configFile, content: JSON.stringify(config, null, 2) });
  } catch (e) {
    addLog(`Config save failed: ${e.message || e}`);
  }
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  config.notify = { ...p };
  config.preset = name;
}

function toggleNotifyEvent(index) {
  const entry = NOTIFY_EVENTS[index];
  if (!entry) return;
  config.notify[entry.key] = !config.notify[entry.key];
  config.preset = presetNameFor(config.notify);
}

function cyclePreset() {
  const idx = PRESET_ORDER.indexOf(config.preset);
  applyPreset(PRESET_ORDER[(idx + 1) % PRESET_ORDER.length]);
}

// ============================================================
// State
// ============================================================
let termCols = parseInt(hecaton.initialState?.cols || '80', 10);
let termRows = parseInt(hecaton.initialState?.rows || '24', 10);

// 9200 and 9217 were both abandoned after leaked listeners from earlier builds
// took them over — see reclaimPreviousServer(), which stops that from recurring.
// A port only needs changing again if a listener leaks from a build without it.
const PORT = 9218;
let serverId = null;
let serverRunning = false;
let patternEnabled = false;
let subscriptionId = null;
const connections = new Map();
const log = [];
const MAX_LOG = 200;

// Terminals currently inside a PreCompact..PostCompact window, keyed by id.
// Claude Code fires Stop for compaction too, so that window has to be ignored.
const compacting = new Map();
const COMPACT_TIMEOUT_MS = 180000;

// ── Terminal naming ────────────────────────────────────────
// "T2496" is the host's internal id and means nothing to a human. Ask the host
// what each terminal actually is and show that instead. The response shape is
// not documented, so every plausible field is probed and the raw payload is
// logged once so the mapping can be corrected against reality.
const terminalInfo = new Map();
let terminalListLogged = false;
let terminalListMissing = false;

// Titles that are just the shell tell us nothing the id doesn't.
const GENERIC_TITLES = new Set([
  'cmd', 'cmd.exe', 'bash', 'sh', 'zsh', 'fish', 'powershell', 'powershell.exe',
  'pwsh', 'pwsh.exe', 'wsl', 'wsl.exe', 'terminal', 'console', 'shell', 'node',
]);

function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut === -1 ? s : s.slice(cut + 1);
}

// The host reports { alias, cwd, shell, id, ... }. An alias is user-chosen and
// always wins; otherwise the working directory names the terminal far better
// than its id. `title` and friends are kept as a cushion for other host builds.
function pickTerminalLabel(t) {
  const alias = String(t.alias || '').trim();
  if (alias) return alias;
  const title = t.title || t.name || t.label || t.tab_title || t.tabTitle || '';
  const cwd = t.cwd || t.path || t.directory || t.working_directory || t.workingDirectory || '';
  const folder = cwd ? baseName(cwd) : '';
  const named = title && !GENERIC_TITLES.has(String(title).trim().toLowerCase());
  return String(named ? title : (folder || title) || '').trim();
}

async function refreshTerminalInfo() {
  if (terminalListMissing) return;
  try {
    const r = await hecaton.terminal.list();
    if (!terminalListLogged) {
      terminalListLogged = true;
      addLog(`terminal.list → ${JSON.stringify(r).slice(0, 240)}`);
    }
    const arr = Array.isArray(r) ? r
      : (r && (r.terminals || r.list || r.items || r.result)) || [];
    if (!Array.isArray(arr)) return;
    terminalInfo.clear();
    for (const t of arr) {
      if (!t || typeof t !== 'object') continue;
      const id = t.id ?? t.terminal_id ?? t.terminalId;
      if (id === undefined || id === null) continue;
      const label = pickTerminalLabel(t);
      if (label) terminalInfo.set(Number(id), label);
    }
  } catch (e) {
    terminalListMissing = true;
    addLog(`terminal.list unavailable: ${e && e.message ? e.message : e}`);
  }
}

// Display name for a terminal — its real name when the host knows one.
function terminalLabel(id, max = 20) {
  const name = terminalInfo.get(id);
  if (!name) return `T${id}`;
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

function isCompacting(terminalId) {
  const since = compacting.get(terminalId);
  if (!since) return false;
  if (Date.now() - since > COMPACT_TIMEOUT_MS) { compacting.delete(terminalId); return false; }
  return true;
}

// ============================================================
// State Machine
// ============================================================
const sm = new AgentStateMachine();

const STATE_COLORS = {
  running: '#50FA7B',   // green
  waiting: '#FFB86C',   // orange
  blocked: '#FF79C6',   // pink — waiting on the user, turn not over
  idle: '#6272A4',      // gray
};
const STATE_ICONS = {
  running: '●',
  waiting: '◐',
  blocked: '◍',
  idle: '○',
};
const STATE_FG = {
  running: ansi.fg.green,
  waiting: ansi.fg.orange,
  blocked: ansi.fg.pink,
  idle: ansi.fg.gray,
};
// Most attention-worthy first — the minimized bar only has room for a couple.
const STATE_ORDER = ['blocked', 'running', 'waiting', 'idle'];

// Hook event -> notification config key. Events absent here never notify,
// which is what keeps mid-turn traffic (PostToolUse, PreCompact, ...) quiet.
const NOTIFY_KEY_BY_EVENT = {
  'Stop': 'Stop',
  'AfterAgent': 'Stop',
  'response': 'Stop',
  'StopFailure': 'StopFailure',
  'PermissionRequest': 'PermissionRequest',
  'SessionStart': 'SessionStart',
  'Notification': 'Idle',
};

const NOTIFY_BODY = {
  Stop: (who) => `${who} — response complete`,
  StopFailure: (who) => `${who} — ended with an error`,
  PermissionRequest: (who) => `${who} — needs permission`,
  SessionStart: (who) => `${who} — session started`,
  Idle: (who) => `${who} — idle`,
};

// What to call this terminal in a notification: its real name when the host
// knows one, otherwise the agent plus the raw id.
function describeTerminal(id, agent) {
  return terminalInfo.get(id) || `${agent || 'claude'} T${id}`;
}

// Same event on the same terminal within this window is treated as a duplicate.
const NOTIFY_DEDUPE_MS = 5000;
const lastNotify = new Map();

function shouldNotify(terminalId, key) {
  if (!key || !config.notify[key]) return false;
  const mapKey = `${terminalId}:${key}`;
  const prev = lastNotify.get(mapKey) || 0;
  const now = Date.now();
  if (now - prev < NOTIFY_DEDUPE_MS) return false;
  lastNotify.set(mapKey, now);
  return true;
}

sm.onTransition = async (terminalId, from, to, info) => {
  const agent = info.agent || 'unknown';

  if (to === null) {
    addLog(`[${agent}] T${terminalId} session ended`);
    lastNotify.delete(`${terminalId}:Stop`);
    compacting.delete(terminalId);
    await hecaton.terminal.set_status({ terminal_id: terminalId, label: '', icon: '', color: '', detail: '' });
    return;
  }

  const icon = STATE_ICONS[to] || '?';
  const color = STATE_COLORS[to] || '#FFFFFF';
  const label = `${icon} ${agent}`;
  const detail = info.model ? `${info.model} (${to})` : to;

  addLog(`[${agent}] T${terminalId} ${from || 'null'} → ${to} (${info.reason || '?'})`);

  await hecaton.terminal.set_status({ terminal_id: terminalId, label, icon: 'radio-tower', color, detail });

  // Pattern matching has no hook event — its running->waiting means "turn done".
  const key = info.reason === 'pattern'
    ? (from === 'running' && to === 'waiting' ? 'Stop' : null)
    : NOTIFY_KEY_BY_EVENT[info.event];

  if (!shouldNotify(terminalId, key)) return;

  const body = (NOTIFY_BODY[key] || NOTIFY_BODY.Stop)(describeTerminal(terminalId, agent));
  await hecaton.notify.send({ terminal_id: terminalId, title: 'Claude State', body });
};

// ============================================================
// Hook event → state mapping
// ============================================================
const EVENT_STATE_MAP = {
  'SessionStart': 'waiting',
  'BeforeAgent': 'running',
  'UserPromptSubmit': 'running',
  'PreToolUse': 'running',
  'PermissionDenied': 'running',
  'PermissionRequest': 'blocked',
  'AfterAgent': 'waiting',
  'Stop': 'waiting',
  'StopFailure': 'waiting',
  'Notification': 'idle',
  'SessionEnd': 'dead',
  'running': 'running',
  'waiting': 'waiting',
  'idle': 'idle',
  'response': 'waiting',
};

// Events that adjust bookkeeping instead of driving a state transition.
const COMPACT_ENTER = 'PreCompact';
const COMPACT_EXIT = 'PostCompact';

function processHookEvent(data) {
  const client = data.client || 'unknown';
  const rawId = parseInt(data.terminal_id, 10);
  const terminalId = Number.isFinite(rawId) ? rawId : 0;
  const event = data.event || data.hook_event_name || 'unknown';
  const model = data.model || '';
  const sessionId = data.session_id || '';

  // Compaction fires Stop as a side effect. Bracket it and drop what lands inside.
  if (event === COMPACT_ENTER) {
    compacting.set(terminalId, Date.now());
    addLog(`[${client}] T${terminalId} compact started`);
    return;
  }
  if (event === COMPACT_EXIT) {
    compacting.delete(terminalId);
    addLog(`[${client}] T${terminalId} compact finished`);
    return;
  }

  // Sole job: take a terminal out of `blocked` once the user answers the prompt.
  // Deliberately ignored otherwise, so a PostToolUse racing a Stop can't undo it.
  if (event === 'PostToolUse') {
    const ts = sm.getState(terminalId);
    if (ts && ts.state === 'blocked') {
      sm.setFromHook(terminalId, 'running', { agent: client, model, sessionId, event, reason: event });
    }
    return;
  }

  // SessionStart also fires on resume/clear/compact. Mid-turn it means the
  // session was reloaded, not that the turn ended — leaving `running` alone
  // keeps the later Stop a real transition instead of a no-op.
  if (event === 'SessionStart') {
    const ts = sm.getState(terminalId);
    if (ts && (ts.state === 'running' || ts.state === 'blocked')) {
      addLog(`[${client}] T${terminalId} SessionStart ignored (mid-turn)`);
      return;
    }
  }

  // A terminal we have no name for is worth one lookup — names are stable, so
  // this fires once per terminal rather than once per event.
  if (!terminalInfo.has(terminalId)) refreshTerminalInfo();

  const state = EVENT_STATE_MAP[event];
  if (!state) {
    addLog(`[${client}] T${terminalId} unknown event: ${event}`);
    return;
  }

  if (config.suppressDuringCompact && isCompacting(terminalId) && (event === 'Stop' || event === 'SessionStart')) {
    addLog(`[${client}] T${terminalId} ${event} ignored (compacting)`);
    return;
  }

  sm.setFromHook(terminalId, state, { agent: client, model, sessionId, event, reason: event });
}

// ============================================================
// Pattern matching (Tier 2)
// ============================================================
let lastCellVersion = 0;

async function onTerminalChanged(params) {
  if (!patternEnabled) return;
  try {
    const cells = await hecaton.terminal.get_cells({ since_version: 0 });
    if (!cells || !cells.rows_data) return;
    if (cells.version === lastCellVersion) return;
    lastCellVersion = cells.version;

    const rows = cells.rows;
    const cols = cells.cols;
    const rowsData = cells.rows_data;

    const lines = [];
    const startRow = Math.max(0, rows - 10);
    for (let r = startRow; r < rows; r++) {
      const rowEntry = rowsData[r];
      if (!rowEntry || !rowEntry.data) { lines.push(''); continue; }
      const raw = atob(rowEntry.data);
      let lineText = '';
      for (let c = 0; c < cols; c++) {
        const offset = c * 12;
        if (offset + 4 > raw.length) break;
        const cp = raw.charCodeAt(offset)
          | (raw.charCodeAt(offset + 1) << 8)
          | (raw.charCodeAt(offset + 2) << 16)
          | (raw.charCodeAt(offset + 3) << 24);
        lineText += cp > 0 ? String.fromCodePoint(cp) : ' ';
      }
      lines.push(lineText.trimEnd());
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return;

    const agent = detectAgent(lines);
    if (!agent) return;

    const terminalId = 0;
    if (isBusy(lines, agent)) {
      sm.setFromPattern(terminalId, 'running', { agent });
    } else if (isPrompt(lines, agent)) {
      sm.setFromPattern(terminalId, 'waiting', { agent });
    }
  } catch (e) {
    addLog(`Pattern error: ${e.message || e}`);
  }
}

// ============================================================
// WebSocket/HTTP server
// ============================================================
// The host owns the listening socket, not this process. If the plugin is killed
// rather than quit — window closed, reloaded, crashed — cleanup never runs and
// that socket stays bound. A second listener on the same port then wins the
// accept queue on Windows and every hook request vanishes into the dead one,
// which is silent and looks exactly like "hooks stopped firing".
//
// So the server_id is written to disk and reclaimed on the next start. It costs
// one stop() call and removes the whole failure mode.
let serverIdFile = null;

async function reclaimPreviousServer() {
  if (!serverIdFile) return;
  let prev = null;
  try {
    const r = await hecaton.fs.read_file({ path: serverIdFile });
    prev = r && r.content ? String(r.content).trim() : null;
  } catch { return; }
  if (!prev) return;
  try {
    const asNum = Number(prev);
    await hecaton.web.stop({ server_id: Number.isFinite(asNum) ? asNum : prev });
    addLog(`Reclaimed leaked server ${prev}`);
  } catch (e) {
    addLog(`Could not reclaim server ${prev}: ${e && e.message ? e.message : e}`);
  }
}

async function rememberServer(id) {
  if (!serverIdFile || id === undefined || id === null) return;
  try {
    await hecaton.fs.write_file({ path: serverIdFile, content: String(id) });
  } catch { /* best effort */ }
}

async function startServer() {
  if (serverRunning) return;
  addLog(`Starting Claude State server on port ${PORT}...`);

  await reclaimPreviousServer();

  const result = await hecaton.web.serve({ port: PORT, host: '127.0.0.1' });
  if (!result || !result.ok) {
    addLog(`Server failed: ${result?.error || 'unknown'}`);
    return;
  }

  serverId = result.server_id;
  serverRunning = true;
  await rememberServer(serverId);
  addLog(`Server running on ws://127.0.0.1:${result.port} (id ${serverId})`);

  await hecaton.web.set_http({
    server_id: serverId,
    content_type: 'application/json',
    body: JSON.stringify({ status: 'ok', message: 'Claude State Hook Server' }),
  });

  rerender();
}

async function stopServer() {
  if (!serverRunning) return;
  if (serverId) {
    await hecaton.web.stop({ server_id: serverId });
    serverId = null;
    await rememberServer('');
  }
  connections.clear();
  serverRunning = false;
  addLog('Server stopped');
  rerender();
}

// ============================================================
// Pattern subscription
// ============================================================
async function startPatternMatching() {
  if (patternEnabled) return;
  patternEnabled = true;
  addLog('Pattern matching enabled (1.5s interval)');

  const result = await hecaton.terminal.subscribe({ interval_ms: 1500 });
  if (result && result.subscription_id) {
    subscriptionId = result.subscription_id;
    addLog(`Subscribed: ${subscriptionId}`);
  }
  rerender();
}

async function stopPatternMatching() {
  if (!patternEnabled) return;
  patternEnabled = false;
  if (subscriptionId) {
    await hecaton.terminal.unsubscribe({ subscription_id: subscriptionId });
    subscriptionId = null;
  }
  addLog('Pattern matching disabled');
  rerender();
}

// ============================================================
// Render
// ============================================================
// The on-screen log dies with the overlay, which makes "did the hook even
// arrive?" impossible to answer after the fact. Mirror it to a file under
// ~/.claude (already covered by this plugin's fs_write grant). Coalesced, and
// failures are swallowed — diagnostics must never break the plugin.
let logFilePath = null;
let logFlushTimer = null;

function scheduleLogFlush() {
  if (!logFilePath || logFlushTimer) return;
  logFlushTimer = setTimeout(async () => {
    logFlushTimer = null;
    try {
      await hecaton.fs.write_file({
        path: logFilePath,
        content: log.slice().reverse().join('\n') + '\n',
      });
    } catch { /* diagnostics only */ }
  }, 300);
}

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  log.unshift(`${time} ${msg}`);
  if (log.length > MAX_LOG) log.pop();
  scheduleLogFlush();
  rerender();
}

// ── Click zones ────────────────────────────────────────────
// Rebuilt on every render. Hover is stored as a coordinate rather than a zone
// index so a zone can decide its own highlight as it is being drawn — the zone
// list does not exist yet at that point.
let clickZones = [];
let hoverRow = -1;
let hoverCol = -1;
let logScroll = 0;
let appliedCursor = null;
let appliedTooltip = null;
let minimized = hecaton.initialState?.minimized ?? false;

// `label` is what the context menu calls this control; `tip` is the hover
// tooltip. Both optional — plain regions (log lines) register neither.
function zone(row, colStart, colEnd, action, opts = {}) {
  clickZones.push({ row, colStart, colEnd, action, ...opts });
  return hoverRow === row && hoverCol >= colStart && hoverCol <= colEnd;
}

function zoneAt(row, col) {
  for (const z of clickZones) {
    if (z.row === row && col >= z.colStart && col <= z.colEnd) return z;
  }
  return null;
}

function chip(text, on, hot) {
  const body = on ? ansi.fg.green : ansi.fg.gray;
  return (hot ? ansi.bg.hover : '') + body + text + ansi.reset;
}

function button(label, hot, tone) {
  const text = `[ ${label} ]`;
  const color = tone || ansi.fg.cyan;
  return (hot ? ansi.bg.hover + ansi.bold : ansi.dim) + color + text + ansi.reset;
}

// Minimized, the overlay is a couple of rows tall. Drawing the full layout
// there scrolls it and leaves the last log line showing — the least useful
// thing on screen. Draw a one-line state summary instead.
function renderMinimized() {
  const tracked = sm.getAll();
  let out = ansi.hideCursor + ansi.clear + ansi.moveTo(1, 2);

  if (!serverRunning) {
    out += ansi.fg.red + MARK_OFF + ' server off' + ansi.reset;
  } else if (tracked.length === 0) {
    out += ansi.fg.gray + MARK_OFF + ' idle' + ansi.reset;
  } else {
    const counts = new Map();
    for (const t of tracked) counts.set(t.state, (counts.get(t.state) || 0) + 1);
    const single = tracked.length === 1;
    const parts = [];
    for (const st of STATE_ORDER) {
      const n = counts.get(st);
      if (!n) continue;
      parts.push((STATE_FG[st] || ansi.fg.gray) + (STATE_ICONS[st] || '?') +
        ' ' + (single ? '' : n + ' ') + st + ansi.reset);
    }
    out += parts.join('  ');
  }

  process.stdout.write(out);
}

// The host renders the minimized label itself, so it stays readable even when
// the overlay row is clipped. Best-effort: older hosts simply lack the call.
let minimizedLabelFailed = false;

function syncMinimizedLabel() {
  if (minimizedLabelFailed) return;
  const tracked = sm.getAll();
  let mark = '', color = '#6272A4';
  if (!serverRunning) { mark = MARK_OFF; color = '#FF5555'; }
  else {
    for (const st of STATE_ORDER) {
      if (tracked.some(t => t.state === st)) { mark = STATE_ICONS[st]; color = STATE_COLORS[st]; break; }
    }
  }
  try {
    const p = hecaton.window.set_minimized_label({
      label: mark ? `Claude ${mark}` : 'Claude',
      color,
    });
    if (p && p.catch) p.catch(() => { minimizedLabelFailed = true; });
  } catch { minimizedLabelFailed = true; }
}

function rerender() {
  syncMinimizedLabel();
  if (minimized) { renderMinimized(); return; }

  clickZones = [];
  const W = Math.max(40, termCols);
  const H = Math.max(12, termRows);
  let out = ansi.hideCursor + ansi.clear;

  // Title
  out += ansi.moveTo(1, 2) + ansi.bold + ansi.fg.orange + 'Claude State' + ansi.reset;
  const ver = 'v1.4.0';
  out += ansi.moveTo(1, Math.max(2, W - ver.length)) + ansi.dim + ver + ansi.reset;

  // ── Hook server ──
  let row = 3;
  {
    const btnLabel = serverRunning ? 'Stop' : 'Start';
    const btnCol = Math.max(20, W - 11);
    const markHot = zone(row, 2, 17, 'toggle-server',
      { label: `${btnLabel} hook server`, tip: `Click to ${btnLabel.toLowerCase()} the hook server` });
    out += ansi.moveTo(row, 2) + chip(serverRunning ? MARK_ON : MARK_OFF, serverRunning, markHot);
    out += (markHot ? ansi.bg.hover : '') + '  Hook Server  ' + ansi.reset;

    out += ansi.moveTo(row, 19) + ansi.dim;
    out += serverRunning ? `${PORT} · ${connections.size} clients` : 'stopped';
    out += ansi.reset;

    const btnHot = zone(row, btnCol, btnCol + btnLabel.length + 3, 'toggle-server',
      { label: `${btnLabel} hook server` });
    out += ansi.moveTo(row, btnCol) + button(btnLabel, btnHot, serverRunning ? ansi.fg.red : ansi.fg.green);
  }

  // ── Pattern matching ──
  row = 4;
  {
    const btnLabel = patternEnabled ? 'Stop' : 'Start';
    const btnCol = Math.max(20, W - 11);
    const markHot = zone(row, 2, 17, 'toggle-pattern',
      { label: `${btnLabel} pattern matching`, tip: 'Screen-scraping fallback when hooks are unavailable' });
    out += ansi.moveTo(row, 2) + chip(patternEnabled ? MARK_ON : MARK_OFF, patternEnabled, markHot);
    out += (markHot ? ansi.bg.hover : '') + '  Pattern Match' + ansi.reset;

    out += ansi.moveTo(row, 19) + ansi.dim;
    out += patternEnabled ? '1.5s interval' : 'off';
    out += ansi.reset;

    const btnHot = zone(row, btnCol, btnCol + btnLabel.length + 3, 'toggle-pattern',
      { label: `${btnLabel} pattern matching` });
    out += ansi.moveTo(row, btnCol) + button(btnLabel, btnHot, patternEnabled ? ansi.fg.red : ansi.fg.green);
  }

  // ── Notify ──
  row = 6;
  {
    out += ansi.moveTo(row, 2) + ansi.bold + 'Notify' + ansi.reset;

    const prevHot = zone(row, 10, 10, 'preset-prev', { label: 'Previous preset' });
    out += ansi.moveTo(row, 10) + (prevHot ? ansi.bg.hover + ansi.bold : ansi.dim) + '<' + ansi.reset;

    const name = config.preset.padEnd(6, ' ');
    const nameHot = zone(row, 12, 12 + name.length - 1, 'preset-next', { label: 'Cycle preset' });
    out += ansi.moveTo(row, 12) + (nameHot ? ansi.bg.hover : '') + ansi.fg.orange + name + ansi.reset;

    const nextHot = zone(row, 19, 19, 'preset-next', { label: 'Next preset' });
    out += ansi.moveTo(row, 19) + (nextHot ? ansi.bg.hover + ansi.bold : ansi.dim) + '>' + ansi.reset;

    const btnCol = Math.max(24, W - 11);
    const btnHot = zone(row, btnCol, btnCol + 8, 'reset-notify', { label: 'Reset to default preset' });
    out += ansi.moveTo(row, btnCol) + button('Reset', btnHot, ansi.fg.cyan);
  }

  row = 7;
  for (let i = 0; i < NOTIFY_EVENTS.length; i++, row++) {
    const e = NOTIFY_EVENTS[i];
    const on = !!config.notify[e.key];
    const hot = zone(row, 3, Math.max(24, W - 2), `notify:${e.key}`,
      { label: `${on ? 'Disable' : 'Enable'} ${e.label} notification`, tip: e.desc });
    const bg = hot ? ansi.bg.hover : '';
    out += ansi.moveTo(row, 3) + bg + chip(on ? MARK_ON : MARK_OFF, on, false);
    out += bg + (on ? ansi.reset + bg : ansi.dim + bg) + ' ' + e.label.padEnd(19, ' ') + ansi.reset;
    out += bg + ansi.dim + e.desc + ansi.reset;
  }

  {
    const on = config.suppressDuringCompact;
    const hot = zone(row, 3, Math.max(24, W - 2), 'toggle-compact',
      { label: `${on ? 'Allow' : 'Suppress'} notifications during compact`,
        tip: 'Compaction fires Stop as a side effect' });
    const bg = hot ? ansi.bg.hover : '';
    out += ansi.moveTo(row, 3) + bg + chip(on ? MARK_ON : MARK_OFF, on, false);
    out += bg + (on ? ansi.reset + bg : ansi.dim + bg) + ' Suppress during compact' + ansi.reset;
    row++;
  }

  // ── Tracked terminals ──
  row++;
  const tracked = sm.getAll();
  out += ansi.moveTo(row, 2) + ansi.bold + 'Terminals' + ansi.reset;
  if (tracked.length) {
    out += ansi.dim + `  (${tracked.length})` + ansi.reset;
  }
  row++;
  if (tracked.length === 0) {
    out += ansi.moveTo(row, 3) + ansi.dim + '(none)' + ansi.reset;
    row++;
  } else {
    // Grow into the space available, but never starve the log completely.
    const budget = Math.max(2, H - row - 4);
    const shown = Math.min(tracked.length, Math.max(4, budget));
    for (let i = 0; i < shown; i++, row++) {
      const t = tracked[i];
      const icon = STATE_ICONS[t.state] || '?';
      const age = t.lastTransition ? `${Math.round((Date.now() - t.lastTransition) / 1000)}s` : '';
      const fg = STATE_FG[t.state] || ansi.fg.gray;
      const named = terminalInfo.has(t.id);
      // Names vary in length; pad them to a column so the states line up and
      // the panel can be read down rather than word by word.
      const nameW = Math.max(12, Math.min(22, Math.floor(W / 3)));
      const raw = terminalLabel(t.id, nameW) +
        (t.agent && t.agent !== 'claude' ? ` (${t.agent})` : '');
      const name = raw.length > nameW ? raw.slice(0, nameW - 1) + '…' : raw.padEnd(nameW, ' ');
      const hot = zone(row, 3, Math.max(24, W - 2), `clear-terminal:${t.id}`,
        { label: `Clear badge for ${raw.trim()}`,
          tip: named ? `T${t.id} · ${t.agent || '?'}` : 'Right-click for terminal actions' });
      const bg = hot ? ansi.bg.hover : '';
      out += ansi.moveTo(row, 3) + bg + fg + icon + ' ' + name + ansi.reset;
      out += bg + ansi.dim + `  ${(t.state || 'null').padEnd(8, ' ')}${age}` +
        (isCompacting(t.id) ? '  compacting' : '') + ansi.reset;
    }
    if (tracked.length > shown) {
      out += ansi.moveTo(row, 3) + ansi.dim + `+${tracked.length - shown} more` + ansi.reset;
      row++;
    }
  }

  // ── Log ──
  row++;
  const logHeaderRow = row;
  out += ansi.moveTo(row, 2) + ansi.bold + 'Log' + ansi.reset;
  {
    const btnCol = Math.max(24, W - 11);
    const btnHot = zone(row, btnCol, btnCol + 8, 'clear-log', { label: 'Clear log' });
    out += ansi.moveTo(row, btnCol) + button('Clear', btnHot, ansi.fg.cyan);
  }
  row++;

  const logRows = Math.max(1, H - row + 1);
  const maxScroll = Math.max(0, log.length - logRows);
  if (logScroll > maxScroll) logScroll = maxScroll;
  for (let i = 0; i < logRows; i++) {
    const line = log[i + logScroll];
    if (line === undefined) break;
    zone(row + i, 1, W, 'log-area');
    out += ansi.moveTo(row + i, 3) + ansi.dim;
    out += line.length > W - 4 ? line.substring(0, W - 7) + '...' : line;
    out += ansi.reset;
  }
  if (maxScroll > 0) {
    const pos = `${logScroll + 1}/${log.length - logRows + 1}`;
    out += ansi.moveTo(logHeaderRow, Math.max(6, W - 24)) + ansi.dim + pos + ansi.reset;
  }

  process.stdout.write(out);
  syncPointer();
}

// Cursor shape and tooltip are host round-trips — only touch them when the
// hovered zone actually changes, otherwise every mouse motion fires two IPC calls.
function syncPointer() {
  const z = zoneAt(hoverRow, hoverCol);
  const wantCursor = (z && z.action !== 'log-area') ? 'pointer' : 'default';
  if (wantCursor !== appliedCursor) {
    appliedCursor = wantCursor;
    try { hecaton.window.set_cursor({ cursor: wantCursor }); } catch { /* optional API */ }
  }
  const wantTip = (z && z.tip) ? z.tip : '';
  if (wantTip !== appliedTooltip) {
    appliedTooltip = wantTip;
    try { hecaton.window.set_tooltip({ text: wantTip }); } catch { /* optional API */ }
  }
}

// ============================================================
// Input handler
// ============================================================
hecaton.on('window_resized', (params) => {
  termCols = params.cols || termCols;
  termRows = params.rows || termRows;
  rerender();
});
hecaton.on('ws_connected', (params) => {
  connections.set(params.connection_id, params.path);
  addLog(`Client connected: ${params.connection_id}`);
});
hecaton.on('ws_message_received', (params) => {
  onWsMessage(params);
});
hecaton.on('ws_disconnected', (params) => {
  connections.delete(params.connection_id);
  addLog(`Client disconnected: ${params.connection_id}`);
});
hecaton.on('http_request_received', (params) => {
  onHttpRequest(params);
});
hecaton.on('terminal_changed', (params) => {
  onTerminalChanged(params);
});
hecaton.on('dialog_resolved', (params) => {
  onDialogResult(params.button_id);
});
hecaton.on('window_minimized', () => {
  minimized = true;
  hoverRow = -1;
  hoverCol = -1;
  appliedTooltip = null;
  rerender();
});
hecaton.on('window_restored', () => {
  minimized = false;
  rerender();
});

// ============================================================
// Actions — every control resolves to one of these, whether it was
// clicked, picked from the context menu, or typed as a shortcut.
// ============================================================
function runAction(action) {
  if (!action || action === 'log-area') return;

  if (action.startsWith('notify:')) {
    const key = action.slice(7);
    const idx = NOTIFY_EVENTS.findIndex(e => e.key === key);
    if (idx === -1) return;
    toggleNotifyEvent(idx);
    saveConfig();
    rerender();
    return;
  }

  if (action.startsWith('clear-terminal:')) {
    const id = parseInt(action.slice(15), 10);
    if (!Number.isFinite(id)) return;
    sm.remove(id);
    compacting.delete(id);
    hecaton.terminal.set_status({ terminal_id: id, label: '', icon: '', color: '', detail: '' })
      .catch(() => null);
    addLog(`T${id} cleared`);
    return;
  }

  switch (action) {
    case 'toggle-server':
      if (serverRunning) stopServer(); else startServer();
      break;
    case 'toggle-pattern':
      if (patternEnabled) stopPatternMatching(); else startPatternMatching();
      break;
    case 'preset-next':
      cyclePreset(); saveConfig(); rerender();
      break;
    case 'preset-prev': {
      const i = PRESET_ORDER.indexOf(config.preset);
      const prev = i <= 0 ? PRESET_ORDER[PRESET_ORDER.length - 1] : PRESET_ORDER[i - 1];
      applyPreset(prev); saveConfig(); rerender();
      break;
    }
    case 'reset-notify':
      applyPreset(DEFAULT_CONFIG.preset);
      config.suppressDuringCompact = DEFAULT_CONFIG.suppressDuringCompact;
      saveConfig(); rerender();
      break;
    case 'toggle-compact':
      config.suppressDuringCompact = !config.suppressDuringCompact;
      saveConfig(); rerender();
      break;
    case 'clear-log':
      log.length = 0; logScroll = 0; rerender();
      break;
    case 'open-log-file':
      if (logFilePath) hecaton.fs.reveal({ path: logFilePath }).catch(() => null);
      break;
    case 'quit':
      cleanup();
      break;
  }
}

// ============================================================
// Mouse
// ============================================================
// Two delivery paths exist: precise events (overlay.precise_mouse) and raw SGR
// on stdin. Both are wired so the UI still works if the host declines one —
// once a precise event arrives, SGR is ignored to avoid double-handling.
let preciseMouseSeen = false;

function onMouseMove(row, col) {
  if (row === hoverRow && col === hoverCol) return;
  hoverRow = row;
  hoverCol = col;
  rerender();
}

function onMouseClick(row, col) {
  const z = zoneAt(row, col);
  if (z) runAction(z.action);
}

function onMouseScroll(deltaY) {
  const step = deltaY > 0 ? 3 : -3;
  const next = Math.max(0, logScroll + step);
  if (next === logScroll) return;
  logScroll = next;
  rerender();
}

hecaton.on('mouse_event', (p) => {
  if (!preciseMouseSeen) addLog('Mouse: precise events active');
  preciseMouseSeen = true;
  const row = (p.cell_y || 0) + 1;
  const col = (p.cell_x || 0) + 1;
  if (p.type === 'motion') onMouseMove(row, col);
  else if (p.type === 'press' && (p.button || 0) === 0) onMouseClick(row, col);
  else if (p.type === 'scroll') onMouseScroll(p.scroll_delta_y || 0);
});

// Fallback: SGR sequences arriving on stdin. Returns true if input was mouse.
let sgrMouseSeen = false;

function handleMouseData(str) {
  if (preciseMouseSeen) return /\x1b\[</.test(str);
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m, had = false;
  while ((m = re.exec(str)) !== null) {
    if (!sgrMouseSeen) { sgrMouseSeen = true; addLog('Mouse: SGR fallback active'); }
    had = true;
    const cb = parseInt(m[1], 10);
    const col = parseInt(m[2], 10);
    const row = parseInt(m[3], 10);
    const release = m[4] === 'm';
    if ((cb & 64) !== 0) onMouseScroll((cb & 1) !== 0 ? 1 : -1);
    else if ((cb & 32) !== 0) onMouseMove(row, col);
    else if (!release && (cb & 3) === 0) onMouseClick(row, col);
  }
  return had;
}

// ============================================================
// Context menu (right click)
// ============================================================
hecaton.on('menu_requested', (p) => {
  const row = p.row || 0;
  const col = p.col || 0;
  const z = zoneAt(row, col);
  const items = [];

  if (z && z.label && z.action !== 'log-area') {
    items.push({ id: z.action, label: z.label, icon: 'check' });
    items.push({ type: 'separator' });
  }

  items.push({
    id: 'toggle-server',
    label: serverRunning ? 'Stop hook server' : 'Start hook server',
    icon: serverRunning ? 'debug-stop' : 'play',
  });
  items.push({
    id: 'toggle-pattern',
    label: patternEnabled ? 'Stop pattern matching' : 'Start pattern matching',
    icon: 'search',
  });
  items.push({ type: 'separator' });

  items.push({
    id: 'notify-menu', label: 'Notify', icon: 'bell',
    children: [
      ...NOTIFY_EVENTS.map(e => ({
        id: `notify:${e.key}`, label: e.label, checked: !!config.notify[e.key],
      })),
      { type: 'separator' },
      { id: 'toggle-compact', label: 'Suppress during compact', checked: config.suppressDuringCompact },
    ],
  });
  items.push({
    id: 'preset-menu', label: `Preset: ${config.preset}`, icon: 'settings',
    children: PRESET_ORDER.map(name => ({
      id: `preset-set:${name}`, label: name, checked: config.preset === name,
    })),
  });
  items.push({ type: 'separator' });
  items.push({ id: 'clear-log', label: 'Clear log', icon: 'trash' });
  if (logFilePath) items.push({ id: 'open-log-file', label: 'Reveal log file', icon: 'go-to-file' });
  items.push({ type: 'separator' });
  items.push({ id: 'quit', label: 'Quit', icon: 'close' });

  hecaton.menu.show({ items });
});

hecaton.on('menu_activated', (p) => {
  const id = p.id || '';
  if (id.startsWith('preset-set:')) {
    applyPreset(id.slice(11));
    saveConfig();
    rerender();
    return;
  }
  runAction(id);
});

function handleInput(data) {
  const str = data.toString();

  if (handleMouseData(str)) return;

  for (const ch of str) {
    switch (ch) {
      case 's':
        runAction('toggle-server');
        break;
      case 'p':
        runAction('toggle-pattern');
        break;
      case 'n':
        runAction('preset-next');
        break;
      case 'c':
        runAction('clear-log');
        break;
      case 'q':
        cleanup();
        break;
    }
  }
  if (str === '\x1b') cleanup();
}

// ============================================================
// WebSocket message handler
// ============================================================
function onWsMessage(params) {
  let data;
  try { data = JSON.parse(params.data); } catch { addLog(`Invalid JSON from ${params.connection_id}`); return; }
  processHookEvent(data);
}

// ============================================================
// HTTP request handler (POST /hook)
// ============================================================
// Only anomalies are logged here — processHookEvent already reports every
// event it accepts, and logging both doubled the log for no added information.
function onHttpRequest(params) {
  if (!params.body) {
    addLog(`HTTP ${params.method || '?'} ${params.path || '?'}: empty body`);
    return;
  }
  let data;
  try { data = JSON.parse(params.body); } catch { addLog('HTTP: invalid JSON body'); return; }
  processHookEvent(data);
}

// ============================================================
// Claude Code Hook Injection
// ============================================================
// PostToolUse is deliberately NOT registered: it fires once per tool call, and
// since the host never answers the request every one of those curls lingers for
// its full timeout. Its only benefit was clearing the `blocked` badge early —
// notifications already work without it, because Stop turns blocked into
// waiting, which is a real transition. processHookEvent still honours the event
// if something else sends it.
const HOOK_EVENTS = [
  { event: 'SessionStart', async: true },
  { event: 'UserPromptSubmit', async: true },
  { event: 'PermissionRequest', async: true },
  { event: 'Stop', async: true },
  { event: 'StopFailure', async: true },
  { event: 'PreCompact', async: true },
  { event: 'PostCompact', async: true },
  // Notification is matched on notification_type — only the idle one is useful here.
  { event: 'Notification', async: true, matcher: 'idle_prompt' },
  { event: 'SessionEnd', async: true },
];

const HOOK_MARKER = 'hecaton-agent-state';

// A live server answers (the host writes 200/404 itself), but a leaked one from
// a dead plugin accepts the connection and then never replies. Without
// --max-time those curls block forever, pile up, and starve the accept queue —
// at which point hooks stop arriving with no error anywhere. The timeout bounds
// that failure; the request is delivered long before it expires. `|| true` keeps
// a timeout (exit 28) from being reported as a failed hook.
function buildHookCommand(eventName) {
  return `curl -s -m 1 --connect-timeout 1 http://127.0.0.1:${PORT}/hook -d "{\\"client\\":\\"claude\\",\\"terminal_id\\":\\"$CONSOLE_TERMINAL_ID\\",\\"event\\":\\"${eventName}\\"}" > /dev/null 2>&1 || true`;
}

function expectedHookCommand(eventName) {
  return `${buildHookCommand(eventName)} # ${HOOK_MARKER}`;
}

function isOurHook(h) {
  return !!(h && h.command &&
    (h.command.includes(HOOK_MARKER) || h.command.includes(`127.0.0.1:${PORT}/hook`)));
}

// True only when our hook exists AND its command matches what this version
// emits, so a plugin upgrade rewrites stale commands instead of skipping them.
function hasCurrentHook(matcherArray, event, matcher = '') {
  if (!Array.isArray(matcherArray)) return false;
  const want = expectedHookCommand(event);
  for (const entry of matcherArray) {
    if ((entry.matcher || '') !== matcher) continue;
    for (const h of entry.hooks || []) {
      if (isOurHook(h)) return h.command === want;
    }
  }
  return false;
}

async function checkAndInjectHooks() {
  try {
    const homeResult = await hecaton.env.get_home();
    const home = homeResult.path || homeResult.value || '';
    if (!home) { addLog('Cannot resolve home dir'); return; }

    const settingsPath = `${home}/.claude/settings.json`;

    let settings = {};
    try {
      const readResult = await hecaton.fs.read_file({ path: settingsPath });
      if (readResult && readResult.content) {
        settings = JSON.parse(readResult.content);
      }
    } catch {
      // File doesn't exist or parse error
    }

    const hooks = settings.hooks || {};

    const stale = HOOK_EVENTS.filter(({ event, matcher }) => !hasCurrentHook(hooks[event], event, matcher || ''));

    if (stale.length === 0) {
      addLog('Claude Code hooks already up to date');
      return;
    }

    await hecaton.dialog.show({
      type: 'message',
      title: 'Install Claude Code Hooks',
      message: `Add or update hooks in Claude Code settings.json\nto enable Claude State detection.\n\nTarget: ${settingsPath}\nOut of date: ${stale.map(e => e.event).join(', ')}`,
      buttons: [
        { id: 'install', label: 'Install', default: true, style: 'success' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });

    pendingDialogAction = 'hook_install';
    pendingSettingsPath = settingsPath;
    pendingSettings = settings;
  } catch (e) {
    addLog(`Hook check error: ${e.message || e}`);
  }
}

let pendingDialogAction = null;
let pendingSettingsPath = null;
let pendingSettings = null;

async function onDialogResult(buttonId) {
  if (pendingDialogAction === 'hook_install') {
    pendingDialogAction = null;
    if (buttonId !== 'install') {
      addLog('Hook installation cancelled by user');
      return;
    }
    await performHookInstall();
  }
}

async function performHookInstall() {
  try {
    const settings = pendingSettings || {};
    const settingsPath = pendingSettingsPath;
    if (!settingsPath) return;

    const hooks = settings.hooks || {};

    for (const { event, async: isAsync, matcher: wanted } of HOOK_EVENTS) {
      const targetMatcher = wanted || '';
      const hookEntry = {
        type: 'command',
        command: expectedHookCommand(event),
        async: isAsync,
      };

      if (!hooks[event]) hooks[event] = [];

      let matcherArr = hooks[event];
      if (!Array.isArray(matcherArr)) matcherArr = hooks[event] = [];

      let found = false;
      for (const entry of matcherArr) {
        if ((entry.matcher || '') === targetMatcher && Array.isArray(entry.hooks)) {
          const existing = entry.hooks.findIndex(isOurHook);
          if (existing === -1) entry.hooks.push(hookEntry);
          else entry.hooks[existing] = hookEntry;  // rewrite stale command in place
          found = true;
          break;
        }
      }

      if (!found) {
        matcherArr.push({ matcher: targetMatcher, hooks: [hookEntry] });
      }
    }

    // Drop our hooks from events we no longer register (e.g. after an upgrade
    // narrows the set), so retired events can't keep firing into a dead port.
    const active = new Set(HOOK_EVENTS.map(e => e.event));
    for (const event of Object.keys(hooks)) {
      if (active.has(event) || !Array.isArray(hooks[event])) continue;
      for (const entry of hooks[event]) {
        if (Array.isArray(entry.hooks)) entry.hooks = entry.hooks.filter(h => !isOurHook(h));
      }
      hooks[event] = hooks[event].filter(entry => (entry.hooks || []).length > 0);
      if (hooks[event].length === 0) delete hooks[event];
    }

    settings.hooks = hooks;

    const content = JSON.stringify(settings, null, 2);
    await hecaton.fs.write_file({ path: settingsPath, content });

    addLog(`Hooks installed to ${settingsPath}`);
    addLog(`${HOOK_EVENTS.length} events registered`);

    pendingSettings = null;
    pendingSettingsPath = null;
  } catch (e) {
    addLog(`Hook install error: ${e.message || e}`);
  }
}

// ============================================================
// Cleanup
// ============================================================
async function cleanup() {
  for (const t of sm.getAll()) {
    await hecaton.terminal.set_status({ terminal_id: t.id, label: '', icon: '', color: '', detail: '' });
  }
  await stopPatternMatching();
  await stopServer();
  // Leave the host's pointer as we found it — the shape is window-wide state.
  try { await hecaton.window.set_cursor({ cursor: 'default' }); } catch { /* optional API */ }
  try { await hecaton.window.set_tooltip({ text: '' }); } catch { /* optional API */ }
  process.stdout.write(ansi.showCursor + ansi.clear);
  process.exit(0);
}

// ============================================================
// Main
// ============================================================
process.stdout.write(ansi.hideCursor);
rerender();

// Register stdin listeners FIRST to keep event loop alive
process.stdin.on('data', handleInput);

// The host tears a plugin down by closing stdin and waiting ~100ms. It does not
// release the plugin's web server itself, and there is no "about to stop" event
// to hook, so this is the only chance to hand the socket back.
//
// Nothing may be awaited here: replies arrive over the channel that just closed,
// so the first `await` would hang until the process is killed and the stop
// request would never even be written. Fire the requests, give stdout a moment
// to flush, and exit. If it does not make it, reclaimPreviousServer() on the
// next start cleans up instead.
let shuttingDown = false;

function emergencyShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (serverId) hecaton.web.stop({ server_id: serverId }); } catch { /* closing */ }
  try {
    if (subscriptionId) hecaton.terminal.unsubscribe({ subscription_id: subscriptionId });
  } catch { /* closing */ }
  setTimeout(() => process.exit(0), 60);
}

process.stdin.on('end', emergencyShutdown);
process.stdin.on('close', emergencyShutdown);

// Then do async initialization (may fail — won't kill plugin)
try { await initLogFile(); } catch (e) { addLog(`Log init error: ${e}`); }
try { await loadConfig(); } catch (e) { addLog(`Config load error: ${e}`); }
try { await refreshTerminalInfo(); } catch (e) { addLog(`Terminal list error: ${e}`); }
try { await startServer(); } catch (e) { addLog(`Server init error: ${e}`); }
try { await checkAndInjectHooks(); } catch (e) { addLog(`Hook check error: ${e}`); }
