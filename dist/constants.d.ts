import type { FallbackPluginConfig } from "./types";
export declare const PLUGIN_NAME = "opencode-model-fallback";
export declare const DEFAULT_CONFIG: Required<FallbackPluginConfig>;
/** Provider-level cooldowns shared by the small_model chain hook and the
 *  fallback chain (a provider that failed a fallback swap is also skipped
 *  by the small_model chain until its cooldown expires). */
export declare const smallModelProviderCooldowns: Map<string, number>;
export declare const RETRYABLE_ERROR_PATTERNS: RegExp[];
