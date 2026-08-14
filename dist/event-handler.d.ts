import type { HookDeps } from "./types";
import type { AutoRetryHelpers } from "./auto-retry";
export declare function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers): {
    handleEvent: ({ event }: {
        event: {
            type: string;
            properties?: unknown;
        };
    }) => Promise<void>;
    handleActivity: (sessionID: string, activityModel?: string) => Promise<void>;
};
