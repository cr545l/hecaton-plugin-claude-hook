#!/usr/bin/env node

/**
 * Agent State — Hecaton Plugin v0.2.0
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
 * Keys: s=toggle server  p=toggle pattern  c=clear log  q/ESC=quit
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
  fg: {
    red: CSI + '31m', green: CSI + '32m', yellow: CSI + '33m',
    cyan: CSI + '36m', white: CSI + '37m', gray: CSI + '90m',
    orange: CSI + '38;5;215m',
  },
  bg: {
    green: CSI + '42m', orange: CSI + '48;5;215m', gray: CSI + '100m',
  },
};

// ============================================================
// State
// ============================================================
let termCols = parseInt(hecaton.initialState?.cols || '80', 10);
let termRows = parseInt(hecaton.initialState?.rows || '24', 10);

const PORT = 9200;
let serverId = null;
let serverRunning = false;
let patternEnabled = false;
let subscriptionId = null;
const connections = new Map();
const log = [];
const MAX_LOG = 50;

// ============================================================
// State Machine
// ============================================================
const sm = new AgentStateMachine();

const STATE_COLORS = {
  running: '#50FA7B',   // green
  waiting: '#FFB86C',   // orange
  idle: '#6272A4',      // gray
};
const STATE_ICONS = {
  running: '●',
  waiting: '◐',
  idle: '○',
};

sm.onTransition = async (terminalId, from, to, info) => {
  const agent = info.agent || 'unknown';

  if (to === null) {
    addLog(`[${agent}] T${terminalId} session ended`);
    await hecaton.terminal.set_status({ terminal_id: terminalId, label: '', icon: '', color: '', detail: '' });
    return;
  }

  const icon = STATE_ICONS[to] || '?';
  const color = STATE_COLORS[to] || '#FFFFFF';
  const label = `${icon} ${agent}`;
  const detail = info.model ? `${info.model} (${to})` : to;

  addLog(`[${agent}] T${terminalId} ${from || 'null'} → ${to} (${info.reason || '?'})`);

  await hecaton.terminal.set_status({ terminal_id: terminalId, label, icon: 'radio-tower', color, detail });

  if (from === 'running' && to === 'waiting') {
    await hecaton.notify.send({ terminal_id: terminalId, title: 'Agent State', body: `${agent} T${terminalId} response complete` });
  }
};

// ============================================================
// Hook event → state mapping
// ============================================================
const EVENT_STATE_MAP = {
  'SessionStart': 'waiting',
  'BeforeAgent': 'running',
  'UserPromptSubmit': 'running',
  'AfterAgent': 'waiting',
  'Stop': 'waiting',
  'PermissionRequest': 'waiting',
  'Notification': 'waiting',
  'SessionEnd': 'dead',
  'running': 'running',
  'waiting': 'waiting',
  'idle': 'idle',
  'response': 'waiting',
};

function processHookEvent(data) {
  const client = data.client || 'unknown';
  const terminalId = parseInt(data.terminal_id || '0', 10);
  const event = data.event || data.hook_event_name || 'unknown';
  const model = data.model || '';
  const sessionId = data.session_id || '';

  const state = EVENT_STATE_MAP[event];
  if (!state) {
    addLog(`[${client}] T${terminalId} unknown event: ${event}`);
    return;
  }
  sm.setFromHook(terminalId, state, { agent: client, model, sessionId });
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
async function startServer() {
  if (serverRunning) return;
  addLog(`Starting agent state server on port ${PORT}...`);

  const result = await hecaton.web.serve({ port: PORT, host: '127.0.0.1' });
  if (!result || !result.ok) {
    addLog(`Server failed: ${result?.error || 'unknown'}`);
    return;
  }

  serverId = result.server_id;
  serverRunning = true;
  addLog(`Server running on ws://127.0.0.1:${result.port}`);

  await hecaton.web.set_http({
    server_id: serverId,
    content_type: 'application/json',
    body: JSON.stringify({ status: 'ok', message: 'Agent State Hook Server' }),
  });

  rerender();
}

async function stopServer() {
  if (!serverRunning) return;
  if (serverId) {
    await hecaton.web.stop({ server_id: serverId });
    serverId = null;
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
function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  log.unshift(`${time} ${msg}`);
  if (log.length > MAX_LOG) log.pop();
  rerender();
}

function rerender() {
  let out = ansi.hideCursor + ansi.clear;

  out += ansi.moveTo(1, 1) + ansi.bold + ansi.fg.orange;
  out += ' Agent State';
  out += ansi.reset + ansi.dim + '  v0.2.0' + ansi.reset;

  out += ansi.moveTo(3, 1);
  if (serverRunning) {
    out += ansi.fg.green + ' ● HOOK SERVER' + ansi.reset;
    out += `  ws://127.0.0.1:${PORT}  clients: ${connections.size}`;
  } else {
    out += ansi.fg.red + ' ○ HOOK SERVER STOPPED' + ansi.reset;
  }

  out += ansi.moveTo(4, 1);
  if (patternEnabled) {
    out += ansi.fg.green + ' ● PATTERN MATCH' + ansi.reset + '  1.5s interval';
  } else {
    out += ansi.fg.gray + ' ○ PATTERN MATCH OFF' + ansi.reset;
  }

  const tracked = sm.getAll();
  out += ansi.moveTo(6, 1) + ansi.bold + ' Tracked Terminals:' + ansi.reset;
  if (tracked.length === 0) {
    out += ansi.moveTo(7, 1) + ansi.dim + '  (none)' + ansi.reset;
  } else {
    for (let i = 0; i < Math.min(tracked.length, 5); i++) {
      const t = tracked[i];
      const icon = STATE_ICONS[t.state] || '?';
      const age = t.lastTransition ? `${Math.round((Date.now() - t.lastTransition) / 1000)}s ago` : '';
      const fg = t.state === 'running' ? ansi.fg.green
        : t.state === 'waiting' ? ansi.fg.orange
        : ansi.fg.gray;
      out += ansi.moveTo(7 + i, 1) + fg;
      out += `  ${icon} T${t.id} ${t.agent || '?'}`;
      out += ansi.reset + ansi.dim + `  ${t.state || 'null'}  ${age}` + ansi.reset;
    }
  }

  const ctrlRow = 7 + Math.min(tracked.length || 1, 5) + 1;
  out += ansi.moveTo(ctrlRow, 1) + ansi.dim;
  out += ` [s] ${serverRunning ? 'Stop' : 'Start'} Server`;
  out += `  [p] ${patternEnabled ? 'Stop' : 'Start'} Pattern`;
  out += `  [c] Clear Log  [q] Quit`;
  out += ansi.reset;

  const logStart = ctrlRow + 2;
  const maxLines = Math.max(1, termRows - logStart);
  out += ansi.moveTo(logStart, 1) + ansi.bold + ' Log:' + ansi.reset;
  for (let i = 0; i < maxLines && i < log.length; i++) {
    out += ansi.moveTo(logStart + 1 + i, 1) + ansi.dim;
    const line = log[i];
    out += '  ' + (line.length > termCols - 3 ? line.substring(0, termCols - 6) + '...' : line);
    out += ansi.reset;
  }

  process.stdout.write(out);
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
hecaton.on('message_received', (params) => {
  onWsMessage(params);
});
hecaton.on('disconnected', (params) => {
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
hecaton.on('window_minimized', () => { rerender(); });
hecaton.on('restored', () => { rerender(); });

function handleInput(data) {
  const str = data.toString();

  for (const ch of str) {
    switch (ch) {
      case 's':
        if (serverRunning) stopServer(); else startServer();
        break;
      case 'p':
        if (patternEnabled) stopPatternMatching(); else startPatternMatching();
        break;
      case 'c':
        log.length = 0;
        rerender();
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
function onHttpRequest(params) {
  addLog(`HTTP: ${JSON.stringify(params).substring(0, 120)}`);
  if (!params.body) return;
  let data;
  try { data = JSON.parse(params.body); } catch { addLog(`Invalid HTTP JSON`); return; }
  processHookEvent(data);
}

// ============================================================
// Claude Code Hook Injection
// ============================================================
const HOOK_EVENTS = [
  { event: 'SessionStart', async: true },
  { event: 'UserPromptSubmit', async: true },
  { event: 'Stop', async: true },
  { event: 'PermissionRequest', async: true },
  { event: 'SessionEnd', async: true },
];

const HOOK_MARKER = 'hecaton-agent-state';

function buildHookCommand(eventName) {
  return `curl -s http://127.0.0.1:${PORT}/hook -d "{\\"client\\":\\"claude\\",\\"terminal_id\\":\\"$CONSOLE_TERMINAL_ID\\",\\"event\\":\\"${eventName}\\"}" > /dev/null 2>&1`;
}

function hasOurHook(matcherArray) {
  if (!Array.isArray(matcherArray)) return false;
  for (const matcher of matcherArray) {
    const hooks = matcher.hooks || [];
    for (const h of hooks) {
      if (h.command && (h.command.includes(HOOK_MARKER) || h.command.includes(`127.0.0.1:${PORT}/hook`))) return true;
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

    let allInstalled = true;
    for (const { event } of HOOK_EVENTS) {
      if (!hasOurHook(hooks[event])) { allInstalled = false; break; }
    }

    if (allInstalled) {
      addLog('Claude Code hooks already installed');
      return;
    }

    await hecaton.dialog.show({
      type: 'message',
      title: 'Install Claude Code Hooks',
      message: `Add hooks to Claude Code settings.json\nto enable agent state detection.\n\nTarget: ${settingsPath}\nEvents: ${HOOK_EVENTS.map(e => e.event).join(', ')}`,
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

    for (const { event, async: isAsync } of HOOK_EVENTS) {
      const command = buildHookCommand(event);
      const hookEntry = {
        type: 'command',
        command: `${command} # ${HOOK_MARKER}`,
        async: isAsync,
      };

      if (!hooks[event]) hooks[event] = [];

      let matcherArr = hooks[event];
      if (!Array.isArray(matcherArr)) matcherArr = hooks[event] = [];

      let found = false;
      for (const matcher of matcherArr) {
        if ((!matcher.matcher || matcher.matcher === '') && Array.isArray(matcher.hooks)) {
          const alreadyHas = matcher.hooks.some(h => h.command && h.command.includes(HOOK_MARKER));
          if (!alreadyHas) matcher.hooks.push(hookEntry);
          found = true;
          break;
        }
      }

      if (!found) {
        matcherArr.push({ matcher: '', hooks: [hookEntry] });
      }
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
process.stdin.on('end', () => { cleanup(); });

// Then do async initialization (may fail — won't kill plugin)
try { await startServer(); } catch (e) { addLog(`Server init error: ${e}`); }
try { await checkAndInjectHooks(); } catch (e) { addLog(`Hook check error: ${e}`); }
