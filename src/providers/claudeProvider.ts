import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import type { CliAdapter, ParsedEvent } from '../cliAdapter.js';
import { CLI_ADAPTER_IDS, PARSED_EVENT_KINDS, SESSION_STRATEGIES } from '../cliAdapter.js';

// ── Helpers ─────────────────────────────────────────────────

function isClaudeOnPath(): boolean {
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return true;
  } catch {
    // On Windows, also check common install locations
    if (process.platform === 'win32') {
      const commonPaths = [
        path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      ];
      for (const p of commonPaths) {
        try {
          execSync(`"${p}" --version`, { stdio: 'ignore' });
          return true;
        } catch {
          // continue checking
        }
      }
    }
    return false;
  }
}

// ── Transcript line parsing ─────────────────────────────────

function parseTranscriptLine(line: string): ParsedEvent[] {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const type = record.type as string | undefined;

    // ── assistant message ──────────────────────────────────
    if (type === 'assistant' && record.message) {
      const msg = record.message as Record<string, unknown>;
      const content = msg.content;
      if (!Array.isArray(content)) return [{ kind: PARSED_EVENT_KINDS.ignored }];

      const blocks = content as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use' && b.id);

      if (toolUseBlocks.length > 0) {
        return toolUseBlocks.map((b) => ({
          kind: PARSED_EVENT_KINDS.toolStart as typeof PARSED_EVENT_KINDS.toolStart,
          toolId: b.id!,
          toolName: b.name || '',
          input: b.input || {},
        }));
      }

      // Text-only response (no tool_use blocks)
      if (blocks.some((b) => b.type === 'text')) {
        return [{ kind: PARSED_EVENT_KINDS.textResponse }];
      }

      return [{ kind: PARSED_EVENT_KINDS.ignored }];
    }

    // ── user message ───────────────────────────────────────
    if (type === 'user' && record.message) {
      const msg = record.message as Record<string, unknown>;
      const content = msg.content;

      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const toolResultBlocks = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id);

        if (toolResultBlocks.length > 0) {
          return toolResultBlocks.map((b) => ({
            kind: PARSED_EVENT_KINDS.toolDone as typeof PARSED_EVENT_KINDS.toolDone,
            toolId: b.tool_use_id!,
          }));
        }

        // Array content with no tool_result → user prompt
        return [{ kind: PARSED_EVENT_KINDS.userPrompt }];
      }

      if (typeof content === 'string' && content.trim()) {
        return [{ kind: PARSED_EVENT_KINDS.userPrompt }];
      }

      return [{ kind: PARSED_EVENT_KINDS.ignored }];
    }

    // ── system turn_duration ───────────────────────────────
    if (type === 'system' && record.subtype === 'turn_duration') {
      return [{ kind: PARSED_EVENT_KINDS.turnEnd }];
    }

    // ── progress records ───────────────────────────────────
    if (type === 'progress') {
      return parseProgressRecord(record);
    }

    return [{ kind: PARSED_EVENT_KINDS.ignored }];
  } catch {
    return [{ kind: PARSED_EVENT_KINDS.ignored }];
  }
}

function parseProgressRecord(record: Record<string, unknown>): ParsedEvent[] {
  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return [{ kind: PARSED_EVENT_KINDS.ignored }];

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return [{ kind: PARSED_EVENT_KINDS.ignored }];

  const dataType = data.type as string | undefined;

  // bash_progress / mcp_progress → tool is executing
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    return [
      {
        kind: PARSED_EVENT_KINDS.toolExecuting,
        parentToolId,
        progressType: dataType,
      },
    ];
  }

  // agent_progress → sub-agent tool events
  if (dataType === 'agent_progress') {
    const msg = data.message as Record<string, unknown> | undefined;
    if (!msg) return [{ kind: PARSED_EVENT_KINDS.ignored }];

    const msgType = msg.type as string;
    const innerMsg = msg.message as Record<string, unknown> | undefined;
    const content = innerMsg?.content;
    if (!Array.isArray(content)) return [{ kind: PARSED_EVENT_KINDS.ignored }];

    if (msgType === 'assistant') {
      const events: ParsedEvent[] = [];
      for (const block of content as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>) {
        if (block.type === 'tool_use' && block.id) {
          events.push({
            kind: PARSED_EVENT_KINDS.subagentToolStart,
            parentToolId,
            toolId: block.id,
            toolName: block.name || '',
            input: block.input || {},
          });
        }
      }
      return events.length > 0 ? events : [{ kind: PARSED_EVENT_KINDS.ignored }];
    }

    if (msgType === 'user') {
      const events: ParsedEvent[] = [];
      for (const block of content as Array<{ type: string; tool_use_id?: string }>) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            kind: PARSED_EVENT_KINDS.subagentToolDone,
            parentToolId,
            toolId: block.tool_use_id,
          });
        }
      }
      return events.length > 0 ? events : [{ kind: PARSED_EVENT_KINDS.ignored }];
    }

    return [{ kind: PARSED_EVENT_KINDS.ignored }];
  }

  return [{ kind: PARSED_EVENT_KINDS.ignored }];
}

// ── Adapter ─────────────────────────────────────────────────

export const claudeAdapter: CliAdapter = {
  id: CLI_ADAPTER_IDS.claude,
  displayName: 'Claude Code',
  terminalNamePrefix: 'Claude Code',
  sessionStrategy: SESSION_STRATEGIES.predictive,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),

  buildCommand(opts) {
    let cmd = `claude --session-id ${opts.sessionId}`;
    if (opts.bypassPermissions) {
      cmd += ' --dangerously-skip-permissions';
    }
    return cmd;
  },

  isAvailable() {
    return isClaudeOnPath();
  },

  getProjectDir(workspacePath) {
    const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', dirName);
  },

  getExpectedJsonlPath(projectDir, sessionId) {
    return path.join(projectDir, `${sessionId}.jsonl`);
  },

  parseTranscriptLine(line) {
    return parseTranscriptLine(line);
  },
};
