import type { PluginContext, FallbackPluginConfig, ChatMessageInput, ChatMessageOutput } from "./types";
export default function OpenCodeFallbackPlugin(ctx: PluginContext, configOverrides?: Partial<FallbackPluginConfig>): Promise<{
    name: string;
    config: (opencodeConfig: Record<string, unknown>) => void;
    event: (arg0: {
        event?: {
            type: string;
            properties?: unknown;
        };
    } | unknown) => Promise<void>;
    "tool.execute.after": (input: {
        tool: string;
        sessionID: string;
        callID: string;
        args: any;
    }, output: {
        title: string;
        output: string;
        metadata: any;
    }) => Promise<void>;
    "chat.message": (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
    "experimental.provider.small_model": (input: {
        provider?: unknown;
    }, output: {
        model?: unknown;
    }) => Promise<void>;
}>;
