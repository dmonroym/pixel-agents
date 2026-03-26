import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getAdapter, getDefaultAdapter } from './adapterRegistry.js';
import type { CliAdapterId } from './cliAdapter.js';
import { CLI_ADAPTER_IDS, SESSION_STRATEGIES } from './cliAdapter.js';
import {
  JSONL_POLL_INTERVAL_MS,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { ensureProjectScan, readNewLines, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

/**
 * Compute the Claude project dir path for /clear detection and terminal adoption.
 * This works even when Claude CLI isn't installed — it just derives the path
 * from the workspace folder name. The directory may not exist if Claude
 * has never been used in this workspace.
 */
export function getProjectDirPath(cwd?: string): string | null {
  const adapter = getAdapter(CLI_ADAPTER_IDS.claude);
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return null;

  // Use adapter if available, otherwise compute directly (matches Claude's convention)
  if (adapter?.getProjectDir) {
    return adapter.getProjectDir(workspacePath);
  }
  const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', dirName);
}

/**
 * Get the Copilot session-state watch directory.
 * Returns the path even if the directory doesn't exist yet.
 */
export function getCopilotSessionDir(): string {
  const adapter = getAdapter(CLI_ADAPTER_IDS.copilot);
  if (adapter?.getSessionWatchDir) {
    return adapter.getSessionWatchDir();
  }
  return path.join(os.homedir(), '.copilot', 'session-state');
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  folderPath?: string,
  bypassPermissions?: boolean,
  cliAdapterId?: CliAdapterId,
): Promise<void> {
  const adapter = cliAdapterId ? getAdapter(cliAdapterId) : getDefaultAdapter();
  if (!adapter) {
    console.log(
      `[Pixel Agents] No CLI adapter available (requested: ${cliAdapterId ?? 'default'})`,
    );
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location that matches the project
  // dir hash Claude Code will use for JSONL transcript files.
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${adapter.terminalNamePrefix} #${idx}`,
    cwd,
  });
  terminal.show();

  const id = nextAgentIdRef.current++;
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;

  if (adapter.sessionStrategy === SESSION_STRATEGIES.predictive) {
    // ── Predictive strategy (Claude): session ID and JSONL path are known before launch ──
    const sessionId = crypto.randomUUID();
    const cmd = adapter.buildCommand({ bypassPermissions: !!bypassPermissions, sessionId });
    terminal.sendText(cmd);

    const projectDir = adapter.getProjectDir!(cwd || '');
    if (!projectDir) {
      console.log(`[Pixel Agents] No project dir for ${adapter.displayName}, cannot track agent`);
      return;
    }

    const expectedFile = adapter.getExpectedJsonlPath!(projectDir, sessionId);
    knownJsonlFiles.add(expectedFile);

    const agent: AgentState = {
      id,
      cliAdapterId: adapter.id,
      terminalRef: terminal,
      projectDir,
      jsonlFile: expectedFile,
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
      folderName,
    };

    agents.set(id, agent);
    activeAgentIdRef.current = id;
    persistAgents();
    console.log(
      `[Pixel Agents] Agent ${id}: created (${adapter.displayName}) for terminal ${terminal.name}`,
    );
    webview?.postMessage({ type: 'agentCreated', id, folderName });

    ensureProjectScan(
      projectDir,
      knownJsonlFiles,
      projectScanTimerRef,
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

    // Poll for the specific JSONL file to appear
    const pollTimer = setInterval(() => {
      try {
        if (fs.existsSync(agent.jsonlFile)) {
          console.log(
            `[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`,
          );
          clearInterval(pollTimer);
          jsonlPollTimers.delete(id);
          startFileWatching(
            id,
            agent.jsonlFile,
            agents,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            webview,
          );
          readNewLines(id, agents, waitingTimers, permissionTimers, webview);
        }
      } catch {
        /* file may not exist yet */
      }
    }, JSONL_POLL_INTERVAL_MS);
    jsonlPollTimers.set(id, pollTimer);
  } else {
    // ── Detective strategy (Copilot): discover the session after launch ──
    const cmd = adapter.buildCommand({ bypassPermissions: !!bypassPermissions });
    terminal.sendText(cmd);

    const watchDir = adapter.getSessionWatchDir!();

    // Build set of already-known session IDs from existing agents using this adapter
    const knownSessions = new Set<string>();
    for (const a of agents.values()) {
      if (a.cliAdapterId === adapter.id && a.jsonlFile) {
        const sessionDir = path.dirname(a.jsonlFile);
        knownSessions.add(path.basename(sessionDir));
      }
    }
    // Also snapshot current sessions before launch so we only detect truly new ones
    if (adapter.findNewSession) {
      // Pre-scan to mark all existing sessions as known
      try {
        const entries = fs.readdirSync(watchDir);
        for (const entry of entries) {
          knownSessions.add(entry);
        }
        console.log(
          `[Pixel Agents] Agent ${id}: pre-scanned ${knownSessions.size} known sessions in ${watchDir}`,
        );
      } catch {
        /* watch dir may not exist yet */
      }
    }

    const agent: AgentState = {
      id,
      cliAdapterId: adapter.id,
      terminalRef: terminal,
      projectDir: watchDir,
      jsonlFile: '',
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
      folderName,
    };

    agents.set(id, agent);
    activeAgentIdRef.current = id;
    persistAgents();
    console.log(
      `[Pixel Agents] Agent ${id}: created (${adapter.displayName}) for terminal ${terminal.name}`,
    );
    webview?.postMessage({ type: 'agentCreated', id, folderName });

    // Poll for new session to appear
    let pollCount = 0;
    const pollTimer = setInterval(() => {
      pollCount++;
      try {
        const session = adapter.findNewSession!(knownSessions);
        if (pollCount <= 3 || (pollCount % 10 === 0 && pollCount <= 30)) {
          console.log(
            `[Pixel Agents] Agent ${id}: poll #${pollCount} → ${session ? `found ${session.sessionId.slice(0, 8)}...` : 'null'}`,
          );
        }
        if (session) {
          // Check if another agent already claimed this session
          if (knownJsonlFiles.has(session.jsonlPath)) {
            console.log(
              `[Pixel Agents] Agent ${id}: session ${session.sessionId.slice(0, 8)} already claimed, skipping`,
            );
            knownSessions.add(session.sessionId);
            return; // Skip, keep polling for a different session
          }

          // FIFO: only claim if no older agent (lower ID) is also waiting for a session.
          // This prevents Agent 2 from stealing Agent 1's session.
          let olderAgentWaiting = false;
          for (const [otherId, otherAgent] of agents) {
            if (otherId < id && otherAgent.cliAdapterId === adapter.id && !otherAgent.jsonlFile) {
              olderAgentWaiting = true;
              break;
            }
          }
          if (olderAgentWaiting) {
            return; // Let the older agent claim it on their next poll
          }

          knownSessions.add(session.sessionId);
          agent.jsonlFile = session.jsonlPath;
          agent.projectDir = watchDir;
          knownJsonlFiles.add(session.jsonlPath);
          console.log(`[Pixel Agents] Agent ${id}: discovered session ${session.sessionId}`);
          clearInterval(pollTimer);
          jsonlPollTimers.delete(id);
          persistAgents();
          startFileWatching(
            id,
            session.jsonlPath,
            agents,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            webview,
          );
          readNewLines(id, agents, waitingTimers, permissionTimers, webview);
        }
      } catch (e) {
        console.log(`[Pixel Agents] Agent ${id}: session poll error: ${e}`);
      }
    }, JSONL_POLL_INTERVAL_MS);
    jsonlPollTimers.set(id, pollTimer);
  }
}

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from maps
  agents.delete(agentId);
  persistAgents();
}

export function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      cliAdapterId: agent.cliAdapterId,
      terminalName: agent.terminalRef.name,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
    });
  }
  context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  webview: vscode.Webview | undefined,
  doPersist: () => void,
): void {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  for (const p of persisted) {
    const terminal = liveTerminals.find((t) => t.name === p.terminalName);
    if (!terminal) continue;

    const agent: AgentState = {
      id: p.id,
      cliAdapterId: p.cliAdapterId ?? CLI_ADAPTER_IDS.claude,
      terminalRef: terminal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
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
      folderName: p.folderName,
    };

    agents.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}"`);

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                agents,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
                webview,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  doPersist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      doPersist,
    );
  }
}

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = context.workspaceState.get<
    Record<string, { palette?: number; seatId?: string }>
  >(WORKSPACE_KEY_AGENT_SEATS, {});

  // Include folderName per agent
  const folderNames: Record<number, string> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
  });

  sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
      });
    }
    // Re-send waiting status
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    }
  }
}

export function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
