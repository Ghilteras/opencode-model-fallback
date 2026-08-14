import type { FallbackState, FallbackResult, FallbackPluginConfig, FallbackPlan, FallbackPlanFailure } from "./types";
export interface FallbackStateSnapshot {
    currentModel: string;
    fallbackIndex: number;
    failedModels: Map<string, number>;
    attemptCount: number;
    pendingFallbackModel?: string;
}
export declare function snapshotFallbackState(state: FallbackState): FallbackStateSnapshot;
export declare function restoreFallbackState(state: FallbackState, snapshot: FallbackStateSnapshot): void;
export declare function createFallbackState(originalModel: string): FallbackState;
export declare function isModelInCooldown(model: string, state: FallbackState, cooldownSeconds: number): boolean;
export declare function findNextAvailableFallback(state: FallbackState, fallbackModels: string[], cooldownSeconds: number): string | undefined;
export declare function prepareFallback(sessionID: string, state: FallbackState, fallbackModels: string[], config: Required<FallbackPluginConfig>): FallbackResult;
/**
 * Phase 1: Determine the next fallback model WITHOUT mutating state.
 * Returns a plan that can be committed later via commitFallback().
 */
export declare function planFallback(sessionID: string, state: FallbackState, fallbackModels: string[], config: Required<FallbackPluginConfig>): FallbackPlan | FallbackPlanFailure;
/**
 * Phase 2: Commit a planned fallback to state. Call this AFTER the replay
 * dispatch to promptAsync succeeds, so state only advances when the new
 * model is actually being called.
 *
 * Idempotent: if the state already shows this plan's model (i.e. another
 * handler already committed the same plan), this is a no-op and returns false.
 */
export declare function commitFallback(state: FallbackState, plan: FallbackPlan): boolean;
export declare function recoverToOriginal(state: FallbackState, cooldownSeconds: number): boolean;
