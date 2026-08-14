/**
 * Config reader for the standalone fallback plugin.
 *
 * Reads `fallback_models` from OpenCode's agent config section
 * (passed via the plugin config hook), NOT from oh-my-opencode.jsonc.
 */
type AgentRecord = Record<string, unknown>;
export declare function normalizeFallbackModelsField(value: unknown): string[];
export declare function readFallbackModels(agentName: string, agents: AgentRecord | undefined): string[];
export declare function resolveAgentForSession(sessionID: string, eventAgent?: string): string | undefined;
export declare function getFallbackModelsForSession(sessionID: string, eventAgent: string | undefined, agents: AgentRecord | undefined, globalFallbackModels?: string[]): string[];
export {};
