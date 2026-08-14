import type { HookDeps, FallbackPlan } from "./types";
export declare function createAutoRetryHelpers(deps: HookDeps): {
    getParentSessionID: (sessionID: string) => Promise<string | null>;
    abortSessionRequest: (sessionID: string, source: string) => Promise<void>;
    clearSessionFallbackTimeout: (sessionID: string) => void;
    scheduleSessionFallbackTimeout: (sessionID: string, resolvedAgent?: string) => void;
    autoRetryWithFallback: (sessionID: string, newModel: string, resolvedAgent: string | undefined, source: string, plan?: FallbackPlan, triggerError?: unknown) => Promise<boolean>;
    resolveAgentForSessionFromContext: (sessionID: string, eventAgent?: string) => Promise<string | undefined>;
    cleanupStaleSessions: () => void;
};
export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>;
