/**
 * Adapter registry — manages available CLI adapters.
 *
 * Provides lookup, availability checking (with 30s cache), and
 * a default-adapter picker that prefers Copilot over Claude.
 */

import type { CliAdapter, CliAdapterId } from './cliAdapter.js';
import { CLI_ADAPTER_IDS } from './cliAdapter.js';
import { ADAPTER_CACHE_TTL_MS } from './constants.js';
import { claudeAdapter } from './providers/claudeProvider.js';
import { copilotAdapter } from './providers/copilotProvider.js';

// ── All known adapters ──────────────────────────────────────
const allAdapters: ReadonlyMap<CliAdapterId, CliAdapter> = new Map([
  [CLI_ADAPTER_IDS.claude, claudeAdapter],
  [CLI_ADAPTER_IDS.copilot, copilotAdapter],
]);

// ── Preference order (higher-priority first) ────────────────
const preferenceOrder: readonly CliAdapterId[] = [CLI_ADAPTER_IDS.copilot, CLI_ADAPTER_IDS.claude];

// ── Availability cache ──────────────────────────────────────
let cachedAvailable: CliAdapter[] | null = null;
let cacheTimestamp = 0;

function refreshCacheIfNeeded(): CliAdapter[] {
  const now = Date.now();
  if (cachedAvailable && now - cacheTimestamp < ADAPTER_CACHE_TTL_MS) {
    return cachedAvailable;
  }
  cachedAvailable = preferenceOrder
    .map((id) => allAdapters.get(id))
    .filter((a): a is CliAdapter => a !== undefined && a.isAvailable());
  cacheTimestamp = now;
  return cachedAvailable;
}

// ── Public API ──────────────────────────────────────────────

/** Returns adapters whose `isAvailable()` is true (cached 30 s). */
export function getAvailableAdapters(): CliAdapter[] {
  return refreshCacheIfNeeded();
}

/** First available adapter (Copilot preferred), or null. */
export function getDefaultAdapter(): CliAdapter | null {
  const available = refreshCacheIfNeeded();
  return available.length > 0 ? available[0] : null;
}

/** Look up an adapter by ID, or null if unknown. */
export function getAdapter(id: CliAdapterId): CliAdapter | null {
  return allAdapters.get(id) ?? null;
}

/** IDs of currently-available adapters (for UI dropdowns). */
export function getAvailableAdapterIds(): CliAdapterId[] {
  return refreshCacheIfNeeded().map((a) => a.id);
}
