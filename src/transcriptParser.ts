import * as path from 'path';
import type * as vscode from 'vscode';

import { getAdapter } from './adapterRegistry.js';
import type { ParsedEvent } from './cliAdapter.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    // Claude Code tool names
    case 'Read':
    case 'view':
      return `Reading ${base(input.file_path ?? input.path)}`;
    case 'Edit':
    case 'edit':
      return `Editing ${base(input.file_path ?? input.path)}`;
    case 'Write':
    case 'create':
      return `Writing ${base(input.file_path ?? input.path)}`;
    case 'Bash':
    case 'powershell': {
      const cmd = ((input.command as string) || '').trim();
      return cmd
        ? `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`
        : 'Running command';
    }
    case 'Glob':
    case 'glob':
      return 'Searching files';
    case 'Grep':
    case 'grep':
      return 'Searching code';
    case 'WebFetch':
    case 'web_fetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent':
    case 'task': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
    case 'ask_user':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return 'Editing notebook';
    case 'report_intent':
      return 'Using report_intent';
    case 'show_file':
      return 'Showing file';
    case 'sql':
      return 'Running query';
    case 'lsp':
      return 'Code intelligence';
    case 'skill':
      return 'Using skill';
    default:
      return `Using ${toolName}`;
  }
}

/** Tools that behave as parent-of-subagent (clearing subagent state on completion) */
const SUBAGENT_PARENT_TOOLS = new Set(['Task', 'Agent', 'task']);

function executeTurnEnd(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  if (agent.activeToolIds.size > 0) {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    webview?.postMessage({ type: 'agentToolsClear', id: agentId });
  }

  agent.isWaiting = true;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;

  const adapter = getAdapter(agent.cliAdapterId);
  if (!adapter) return;

  let events: ParsedEvent[];
  try {
    events = adapter.parseTranscriptLine(line);
  } catch {
    return;
  }

  const exemptTools = adapter.permissionExemptTools;

  for (const event of events) {
    switch (event.kind) {
      case 'toolStart': {
        cancelWaitingTimer(agentId, waitingTimers);
        // Clear permission state when new data flows from the main agent
        cancelPermissionTimer(agentId, permissionTimers);
        if (agent.permissionSent) {
          agent.permissionSent = false;
          webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
        }
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

        const status = formatToolStatus(event.toolName, event.input);
        console.log(`[Pixel Agents] Agent ${agentId} tool start: ${event.toolId} ${status}`);
        agent.activeToolIds.add(event.toolId);
        agent.activeToolStatuses.set(event.toolId, status);
        agent.activeToolNames.set(event.toolId, event.toolName);

        if (!exemptTools.has(event.toolName)) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools, webview);
        }
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: event.toolId,
          status,
        });
        break;
      }

      case 'toolDone': {
        console.log(`[Pixel Agents] Agent ${agentId} tool done: ${event.toolId}`);
        const completedToolName = agent.activeToolNames.get(event.toolId);
        if (completedToolName && SUBAGENT_PARENT_TOOLS.has(completedToolName)) {
          agent.activeSubagentToolIds.delete(event.toolId);
          agent.activeSubagentToolNames.delete(event.toolId);
          webview?.postMessage({
            type: 'subagentClear',
            id: agentId,
            parentToolId: event.toolId,
          });
        }
        agent.activeToolIds.delete(event.toolId);
        agent.activeToolStatuses.delete(event.toolId);
        agent.activeToolNames.delete(event.toolId);

        const toolId = event.toolId;
        setTimeout(() => {
          webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
        }, TOOL_DONE_DELAY_MS);

        if (agent.activeToolIds.size === 0) {
          agent.hadToolsInTurn = false;
        }
        break;
      }

      case 'turnEnd': {
        // While subagents are running (Copilot mixes all events in one file),
        // suppress turnEnd — these are subagent turn boundaries, not the main agent's.
        if (agent.activeSubagentCount > 0) {
          console.log(
            `[Pixel Agents] Agent ${agentId} turnEnd suppressed (${agent.activeSubagentCount} subagent(s) active)`,
          );
          break;
        }

        executeTurnEnd(agentId, agents, waitingTimers, permissionTimers, webview);
        break;
      }

      case 'textResponse': {
        if (!agent.hadToolsInTurn) {
          startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
        }
        break;
      }

      case 'userPrompt': {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
        agent.activeSubagentCount = 0;
        break;
      }

      case 'toolExecuting': {
        // Tool execution progress — restart permission timer (tool is alive)
        // Also clear any existing permission bubble since we got fresh data
        if (agent.permissionSent) {
          agent.permissionSent = false;
          webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
        }
        if (agent.activeToolIds.has(event.parentToolId)) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools, webview);
        }
        break;
      }

      case 'subagentToolStart': {
        const status = formatToolStatus(event.toolName, event.input);
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${event.toolId} ${status} (parent: ${event.parentToolId})`,
        );

        let subTools = agent.activeSubagentToolIds.get(event.parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(event.parentToolId, subTools);
        }
        subTools.add(event.toolId);

        let subNames = agent.activeSubagentToolNames.get(event.parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(event.parentToolId, subNames);
        }
        subNames.set(event.toolId, event.toolName);

        if (!exemptTools.has(event.toolName)) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools, webview);
        }
        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId: event.parentToolId,
          toolId: event.toolId,
          status,
        });
        break;
      }

      case 'subagentToolDone': {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${event.toolId} (parent: ${event.parentToolId})`,
        );

        const subTools = agent.activeSubagentToolIds.get(event.parentToolId);
        if (subTools) subTools.delete(event.toolId);
        const subNames = agent.activeSubagentToolNames.get(event.parentToolId);
        if (subNames) subNames.delete(event.toolId);

        const toolId = event.toolId;
        const parentToolId = event.parentToolId;
        setTimeout(() => {
          webview?.postMessage({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, TOOL_DONE_DELAY_MS);

        // Check if still has non-exempt sub-tools
        let stillHasNonExempt = false;
        for (const [, names] of agent.activeSubagentToolNames) {
          for (const [, name] of names) {
            if (!exemptTools.has(name)) {
              stillHasNonExempt = true;
              break;
            }
          }
          if (stillHasNonExempt) break;
        }
        if (stillHasNonExempt) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools, webview);
        }
        break;
      }

      case 'subagentStarted': {
        agent.activeSubagentCount++;
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent started (${agent.activeSubagentCount} active)`,
        );
        const status = `Subtask: ${event.agentName}`;
        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId: event.parentToolId,
          toolId: event.parentToolId + ':sub',
          status,
        });
        break;
      }

      case 'subagentCompleted': {
        agent.activeSubagentCount = Math.max(0, agent.activeSubagentCount - 1);
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent completed (${agent.activeSubagentCount} remaining)`,
        );
        webview?.postMessage({
          type: 'subagentClear',
          id: agentId,
          parentToolId: event.parentToolId,
        });
        break;
      }

      case 'ignored':
        break;
    }
  }
}

/** Check if a tool_result block indicates an async/background agent launch */
function isAsyncAgentResult(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}
