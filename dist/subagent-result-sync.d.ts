import type { HookDeps } from "./types";
/**
 * Detect whether a task tool output contains an empty <task_result> tag,
 * indicating the child session returned no content (likely due to a model
 * failure that triggered fallback).
 */
export declare function isEmptyTaskResult(output: string): boolean;
export declare function extractChildSessionID(output: string): string | null;
export interface WaitOptions {
    /** Maximum time to wait in milliseconds */
    maxWaitMs?: number;
    /** Polling interval in milliseconds (only used as fallback for streaming check) */
    pollIntervalMs?: number;
}
/**
 * Wait for child session fallback to complete and return the assistant's
 * response text.  Uses a hybrid approach:
 *
 * - Event-driven session.idle detection (fastest path)
 * - Polling fallback via session.get() (survives plugin reinit)
 * - Activity-aware timeout: resets every time a message.updated is received
 *   for the child, so active sessions never time out prematurely
 *
 * Returns null if the wait times out or no valid assistant response is found.
 */
export declare function waitForChildFallbackResult(deps: HookDeps, childSessionID: string, options?: WaitOptions): Promise<string | null>;
