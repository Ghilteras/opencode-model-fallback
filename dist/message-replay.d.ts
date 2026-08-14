import type { MessagePart, ReplayTier, ReplayResult } from "./types";
export declare function filterPartsByTier(parts: MessagePart[], tier: ReplayTier): MessagePart[];
export declare function replayWithDegradation(allParts: MessagePart[], sendFn: (parts: MessagePart[]) => Promise<void>): Promise<ReplayResult>;
