import type { HookDeps, ChatMessageInput, ChatMessageOutput } from "./types";
import type { AutoRetryHelpers } from "./auto-retry";
export declare function createChatMessageHandler(deps: HookDeps, helpers: AutoRetryHelpers): (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
