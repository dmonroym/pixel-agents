import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getAdapter } from './adapterRegistry.js';
import { CLI_ADAPTER_IDS, type CliAdapterId, SESSION_STRATEGIES } from './cliAdapter.js';
import {
  FILE_WATCHER_POLL_INTERVAL_MS,
  PROJECT_SCAN_INTERVAL_MS,
  SESSION_STALE_THRESHOLD_MS,
} from './constants.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Detect the CLI adapter from a JSONL file path. */
function detectAdapterFromPath(jsonlPath: string): CliAdapterId {
  const normalized = jsonlPath.replace(/\\/g, '/');
  if (normalized.includes('/.copilot/') || normalized.includes('.copilot/session-state/')) {
    return CLI_ADAPTER_IDS.copilot;
  }
  return CLI_ADAPTER_IDS.claude;
}

export function startFileWatching(
  agentId: number,
  filePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  knownJsonlFiles?: Set<string>,
  persistAgents?: () => void,
  workspacePath?: string,
): void {
  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  // Previously used triple-redundant fs.watch + fs.watchFile + setInterval, but
  // fs.watch is unreliable on macOS/WSL2 and the redundancy created 3 timers per
  // agent doing synchronous I/O. The manual poll at 500ms is fast enough for a
  // pixel art visualization and works everywhere.
  const interval = setInterval(() => {
    const agent = agents.get(agentId);
    if (!agent) {
      clearInterval(interval);
      return;
    }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);

    // Session re-detection for detective-strategy CLIs (Copilot).
    // When /resume switches to a different session, the old events.jsonl goes stale.
    // After SESSION_STALE_THRESHOLD_MS of no data, re-scan for a newer session.
    if (knownJsonlFiles && persistAgents) {
      const adapter = getAdapter(agent.cliAdapterId);
      if (
        adapter?.sessionStrategy === SESSION_STRATEGIES.detective &&
        agent.lastDataAt > 0 &&
        Date.now() - agent.lastDataAt > SESSION_STALE_THRESHOLD_MS
      ) {
        const claimedSessionIds = new Set<string>();
        for (const [otherId, otherAgent] of agents) {
          if (
            otherId !== agentId &&
            otherAgent.cliAdapterId === agent.cliAdapterId &&
            otherAgent.jsonlFile
          ) {
            claimedSessionIds.add(path.basename(path.dirname(otherAgent.jsonlFile)));
          }
        }
        // Also claim our own current session so we don't re-find it
        if (agent.jsonlFile) {
          claimedSessionIds.add(path.basename(path.dirname(agent.jsonlFile)));
        }

        const session = adapter.findNewSession?.(
          claimedSessionIds,
          agent.lastDataAt,
          workspacePath,
        );
        if (session) {
          console.log(
            `[Pixel Agents] Agent ${agentId}: session went stale, switching to ${session.sessionId.slice(0, 8)}...`,
          );
          agent.jsonlFile = session.jsonlPath;
          agent.fileOffset = 0;
          agent.lineBuffer = '';
          agent.lastDataAt = Date.now();
          knownJsonlFiles.add(session.jsonlPath);
          clearAgentActivity(agent, agentId, permissionTimers, webview);
          persistAgents();
        }
      }
    }
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    // Remaining data will be picked up on the next poll cycle.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel waiting timer (data flowing means not idle).
      // Permission timer is managed by processTranscriptLine to avoid false
      // clears from subagent chatter in Copilot's shared events.jsonl.
      cancelWaitingTimer(agentId, waitingTimers);
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
    }
  } catch (e) {
    console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
  }
}

export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  if (projectScanTimerRef.current) return;
  // Seed with all existing JSONL files so we only react to truly new ones
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      knownJsonlFiles.add(f);
    }
  } catch {
    /* dir may not exist yet */
  }

  projectScanTimerRef.current = setInterval(() => {
    scanForNewJsonlFiles(
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
    );
  }, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (!knownJsonlFiles.has(file)) {
      knownJsonlFiles.add(file);
      if (activeAgentIdRef.current !== null) {
        // Active agent focused → /clear reassignment
        console.log(
          `[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`,
        );
        reassignAgentToFile(
          activeAgentIdRef.current,
          file,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
          persistAgents,
        );
      } else {
        // No active agent → try to adopt the focused terminal
        const activeTerminal = vscode.window.activeTerminal;
        if (activeTerminal) {
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === activeTerminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            adoptTerminalForFile(
              activeTerminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              webview,
              persistAgents,
            );
          }
        } else {
          console.log(
            `[Pixel Agents] New JSONL detected but no active agent or terminal to adopt: ${path.basename(file)}`,
          );
        }
      }
    }
  }

  // Clean up orphaned agents whose terminals have been closed
  for (const [id, agent] of agents) {
    if (agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Agent ${id}: terminal closed, cleaning up orphan`);
      // Stop file watching
      fileWatchers.get(id)?.close();
      fileWatchers.delete(id);
      const pt = pollingTimers.get(id);
      if (pt) {
        clearInterval(pt);
      }
      pollingTimers.delete(id);
      cancelWaitingTimer(id, waitingTimers);
      cancelPermissionTimer(id, permissionTimers);
      agents.delete(id);
      persistAgents();
      webview?.postMessage({ type: 'agentClosed', id });
    }
  }
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    cliAdapterId: detectAdapterFromPath(jsonlFile),
    terminalRef: terminal,
    projectDir,
    jsonlFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    activeSubagentCount: 0,
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(
    `[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );
  webview?.postMessage({ type: 'agentCreated', id });

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

/**
 * Scan Copilot's session-state directory for sessions that already exist
 * but aren't tracked by any agent. This enables adopting terminals that
 * were started outside of Pixel Agents (e.g., manually running `copilot`).
 */
export function ensureCopilotScan(
  copilotSessionDir: string,
  knownJsonlFiles: Set<string>,
  copilotScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  if (copilotScanTimerRef.current) return;

  // Seed with all existing sessions so we only react to truly new ones
  try {
    const entries = fs.readdirSync(copilotSessionDir);
    for (const entry of entries) {
      const eventsPath = path.join(copilotSessionDir, entry, 'events.jsonl');
      try {
        if (fs.statSync(eventsPath).isFile()) {
          knownJsonlFiles.add(eventsPath);
        }
      } catch {
        /* no events.jsonl in this dir */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  copilotScanTimerRef.current = setInterval(() => {
    scanForNewCopilotSessions(
      copilotSessionDir,
      knownJsonlFiles,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
    );
  }, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewCopilotSessions(
  copilotSessionDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(copilotSessionDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const eventsPath = path.join(copilotSessionDir, entry, 'events.jsonl');
    if (knownJsonlFiles.has(eventsPath)) continue;

    try {
      if (!fs.statSync(eventsPath).isFile()) continue;
    } catch {
      continue;
    }

    knownJsonlFiles.add(eventsPath);

    // Only adopt if there's an active unowned terminal
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) continue;

    let owned = false;
    for (const agent of agents.values()) {
      if (agent.terminalRef === activeTerminal) {
        owned = true;
        break;
      }
    }
    if (owned) continue;

    adoptTerminalForFile(
      activeTerminal,
      eventsPath,
      copilotSessionDir,
      nextAgentIdRef,
      agents,
      activeAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
    );
  }
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, permissionTimers, webview);

  // Swap to new file
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
