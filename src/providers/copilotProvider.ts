/**
 * Copilot CLI adapter.
 *
 * Implements CliAdapter for the GitHub Copilot CLI, which stores
 * session transcripts at ~/.copilot/session-state/<session-uuid>/events.jsonl.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, normalize } from 'path';

import type { CliAdapter, ParsedEvent } from '../cliAdapter.js';
import { CLI_ADAPTER_IDS, PARSED_EVENT_KINDS, SESSION_STRATEGIES } from '../cliAdapter.js';

// ── Types for JSONL event parsing ───────────────────────────

interface ToolRequest {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  type: string;
}

interface CopilotEvent {
  type: string;
  data: {
    toolRequests?: ToolRequest[];
    toolCallId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    kind?: { type: string; agentId?: string };
    agentName?: string;
    agentDescription?: string;
  };
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ── Adapter ─────────────────────────────────────────────────

export const copilotAdapter: CliAdapter = {
  id: CLI_ADAPTER_IDS.copilot,
  displayName: 'Copilot',
  terminalNamePrefix: 'Copilot',
  sessionStrategy: SESSION_STRATEGIES.detective,

  permissionExemptTools: new Set(['task', 'skill', 'ask_user', 'report_intent']),

  buildCommand(opts: { bypassPermissions: boolean; sessionId?: string }): string {
    return opts.bypassPermissions ? 'copilot --allow-all-tools' : 'copilot';
  },

  isAvailable(): boolean {
    try {
      execSync('copilot --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  getSessionWatchDir(): string {
    return join(homedir(), '.copilot', 'session-state');
  },

  findNewSession(
    claimedSessionIds: Set<string>,
    sinceTimestamp: number,
    workspacePath?: string,
  ): { sessionId: string; jsonlPath: string } | null {
    const watchDir = this.getSessionWatchDir!();
    if (!existsSync(watchDir)) {
      return null;
    }

    let newest: { sessionId: string; jsonlPath: string; mtime: number } | null = null;

    let entries: string[];
    try {
      entries = readdirSync(watchDir);
    } catch {
      return null;
    }

    // Normalize workspace path for case-insensitive comparison on Windows
    const normalizedWorkspace = workspacePath ? normalize(workspacePath).toLowerCase() : null;

    for (const entry of entries) {
      // Skip sessions already assigned to other agents
      if (claimedSessionIds.has(entry)) {
        continue;
      }
      const eventsPath = join(watchDir, entry, 'events.jsonl');
      try {
        const stat = statSync(eventsPath);
        if (stat.isFile()) {
          const mtime = stat.mtimeMs;
          // Only consider sessions modified after the poll started.
          // Copilot reuses session directories, so we can't rely on
          // "new directory" detection — we need to find recently active sessions.
          if (mtime < sinceTimestamp) continue;

          // If workspace path is provided, match against session's cwd from workspace.yaml
          if (normalizedWorkspace) {
            const wsYamlPath = join(watchDir, entry, 'workspace.yaml');
            try {
              const wsContent = readFileSync(wsYamlPath, 'utf8');
              const cwdMatch = wsContent.match(/^cwd:\s*(.+)$/m);
              if (cwdMatch) {
                const sessionCwd = normalize(cwdMatch[1].trim()).toLowerCase();
                if (sessionCwd !== normalizedWorkspace) continue;
              }
            } catch {
              // No workspace.yaml or can't read — skip this session
              continue;
            }
          }

          if (newest === null || mtime > newest.mtime) {
            newest = { sessionId: entry, jsonlPath: eventsPath, mtime };
          }
        }
      } catch {
        // events.jsonl doesn't exist in this directory — skip
      }
    }

    if (newest === null) {
      return null;
    }
    return { sessionId: newest.sessionId, jsonlPath: newest.jsonlPath };
  },

  parseTranscriptLine(line: string): ParsedEvent[] {
    let event: CopilotEvent;
    try {
      event = JSON.parse(line) as CopilotEvent;
    } catch {
      return [{ kind: PARSED_EVENT_KINDS.ignored }];
    }

    switch (event.type) {
      case 'assistant.message': {
        const toolRequests = event.data.toolRequests;
        if (!toolRequests || toolRequests.length === 0) {
          return [{ kind: PARSED_EVENT_KINDS.textResponse }];
        }
        return toolRequests.map((req) => ({
          kind: PARSED_EVENT_KINDS.toolStart as typeof PARSED_EVENT_KINDS.toolStart,
          toolId: req.toolCallId,
          toolName: req.name,
          input: req.arguments ?? {},
        }));
      }

      case 'tool.execution_start': {
        return [
          {
            kind: PARSED_EVENT_KINDS.toolExecuting,
            parentToolId: event.data.toolCallId ?? event.id,
            progressType: 'tool_execution',
          },
        ];
      }

      case 'tool.execution_complete': {
        // In Copilot CLI, tool.execution_complete means "dispatch complete" —
        // the tool framework has handled the call, but for task/sub-agent tools
        // the actual work is still running. We treat this as toolExecuting
        // (resets permission timer) and let assistant.turn_end clear tools.
        return [
          {
            kind: PARSED_EVENT_KINDS.toolExecuting,
            parentToolId: event.data.toolCallId ?? event.id,
            progressType: 'tool_execution_complete',
          },
        ];
      }

      case 'assistant.turn_end': {
        return [{ kind: PARSED_EVENT_KINDS.turnEnd }];
      }

      case 'user.message': {
        return [{ kind: PARSED_EVENT_KINDS.userPrompt }];
      }

      case 'subagent.started': {
        return [
          {
            kind: PARSED_EVENT_KINDS.subagentStarted,
            parentToolId: event.data.toolCallId ?? event.id,
            agentName: event.data.agentName ?? 'subagent',
            description: event.data.agentDescription ?? '',
          },
        ];
      }

      case 'subagent.completed': {
        // Copilot emits this with data.toolCallId matching the original tool call.
        // system.notification follows with a human-readable agentId, but we use
        // toolCallId here since it matches what subagent.started provided.
        return [
          {
            kind: PARSED_EVENT_KINDS.subagentCompleted,
            parentToolId: event.data.toolCallId ?? event.id,
          },
        ];
      }

      case 'system.notification': {
        // system.notification with kind.type 'agent_completed'/'agent_idle' follows
        // subagent.completed. Since we now handle subagent.completed directly,
        // ignore these to avoid double-decrementing activeSubagentCount.
        return [{ kind: PARSED_EVENT_KINDS.ignored }];
      }

      default:
        return [{ kind: PARSED_EVENT_KINDS.ignored }];
    }
  },
};
