import type { HookDeps } from "./types";
import type { AutoRetryHelpers } from "./auto-retry";
import { extractAutoRetrySignal } from "./error-classifier";
export declare function hasVisibleAssistantResponse(extractAutoRetrySignalFn: typeof extractAutoRetrySignal): (ctx: HookDeps["ctx"], sessionID: string, _info: Record<string, unknown> | undefined) => Promise<boolean>;
export declare function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers): (props: Record<string, unknown> | undefined) => Promise<void>;
