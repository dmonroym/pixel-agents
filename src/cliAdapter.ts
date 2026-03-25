/**
 * CLI Adapter interface and shared types.
 *
 * Each supported CLI (Claude Code, Copilot CLI, etc.) implements CliAdapter
 * to encapsulate its command, session detection, JSONL format, and paths.
 */

// ── Adapter IDs ──────────────────────────────────────────────
export const CLI_ADAPTER_IDS = {
  claude: 'claude',
  copilot: 'copilot',
} as const;

export type CliAdapterId = (typeof CLI_ADAPTER_IDS)[keyof typeof CLI_ADAPTER_IDS];

// ── Parsed Event (unified output from all transcript parsers) ─
export const PARSED_EVENT_KINDS = {
  toolStart: 'toolStart',
  toolDone: 'toolDone',
  toolExecuting: 'toolExecuting',
  turnEnd: 'turnEnd',
  textResponse: 'textResponse',
  userPrompt: 'userPrompt',
  subagentToolStart: 'subagentToolStart',
  subagentToolDone: 'subagentToolDone',
  subagentStarted: 'subagentStarted',
  subagentCompleted: 'subagentCompleted',
  ignored: 'ignored',
} as const;

export type ParsedEvent =
  | {
      kind: typeof PARSED_EVENT_KINDS.toolStart;
      toolId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { kind: typeof PARSED_EVENT_KINDS.toolDone; toolId: string }
  | {
      kind: typeof PARSED_EVENT_KINDS.toolExecuting;
      parentToolId: string;
      progressType: string;
    }
  | { kind: typeof PARSED_EVENT_KINDS.turnEnd }
  | { kind: typeof PARSED_EVENT_KINDS.textResponse }
  | { kind: typeof PARSED_EVENT_KINDS.userPrompt }
  | {
      kind: typeof PARSED_EVENT_KINDS.subagentToolStart;
      parentToolId: string;
      toolId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      kind: typeof PARSED_EVENT_KINDS.subagentToolDone;
      parentToolId: string;
      toolId: string;
    }
  | {
      kind: typeof PARSED_EVENT_KINDS.subagentStarted;
      parentToolId: string;
      agentName: string;
      description: string;
    }
  | {
      kind: typeof PARSED_EVENT_KINDS.subagentCompleted;
      parentToolId: string;
    }
  | { kind: typeof PARSED_EVENT_KINDS.ignored };

// ── Session Detection Strategy ───────────────────────────────
// predictive: we generate a session ID, know the JSONL path ahead of time (Claude)
// detective: we watch a directory for new sessions after launching (Copilot)
export const SESSION_STRATEGIES = {
  predictive: 'predictive',
  detective: 'detective',
} as const;

export type SessionStrategy = (typeof SESSION_STRATEGIES)[keyof typeof SESSION_STRATEGIES];

// ── Session Info (returned by detective strategy) ────────────
export interface DetectedSession {
  sessionId: string;
  jsonlPath: string;
}

// ── CLI Adapter Interface ────────────────────────────────────
export interface CliAdapter {
  /** Unique adapter identifier */
  readonly id: CliAdapterId;

  /** Human-readable name for UI (e.g., "Claude Code", "Copilot") */
  readonly displayName: string;

  /** Prefix for terminal tab names (e.g., "Claude Code", "Copilot") */
  readonly terminalNamePrefix: string;

  /** How this CLI's sessions are detected */
  readonly sessionStrategy: SessionStrategy;

  /** Tools that don't require user permission approval */
  readonly permissionExemptTools: ReadonlySet<string>;

  /**
   * Build the shell command to launch the CLI.
   * @param opts.bypassPermissions - skip all tool approval prompts
   * @param opts.sessionId - session ID (only used by predictive strategy)
   */
  buildCommand(opts: { bypassPermissions: boolean; sessionId?: string }): string;

  /**
   * Check if this CLI is available on the system (e.g., on PATH).
   */
  isAvailable(): boolean;

  // ── Predictive strategy (Claude) ─────────────────────────
  /**
   * Get the project directory where JSONL transcripts are stored.
   * @param workspacePath - the VS Code workspace folder path
   */
  getProjectDir?(workspacePath: string): string;

  /**
   * Get the expected JSONL file path for a known session ID.
   * @param projectDir - from getProjectDir()
   * @param sessionId - the UUID we generated
   */
  getExpectedJsonlPath?(projectDir: string, sessionId: string): string;

  // ── Detective strategy (Copilot) ─────────────────────────
  /**
   * Get the directory to watch for new session directories.
   */
  getSessionWatchDir?(): string;

  /**
   * Find a new session that appeared since last check.
   * @param knownSessions - set of session IDs already known
   * @returns the new session info, or null if none found
   */
  findNewSession?(knownSessions: Set<string>): DetectedSession | null;

  // ── Transcript Parsing ───────────────────────────────────
  /**
   * Parse a single JSONL line into a unified ParsedEvent.
   * Returns an array because one line can contain multiple events
   * (e.g., an assistant message with multiple tool requests).
   */
  parseTranscriptLine(line: string): ParsedEvent[];
}
