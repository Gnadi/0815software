import { BaseClient } from './http.js';
import type { ChatInput, ChatResult, RagSearchInput } from './types.js';
/** Client for PS-04 AI Platform (default port 4004). */
export declare class AiClient extends BaseClient {
    chat(input: ChatInput): Promise<ChatResult>;
    embed(input: {
        model?: string;
        input: string | string[];
    }): Promise<{
        embeddings: number[][];
    }>;
    ragSearch(input: RagSearchInput): Promise<{
        matches: {
            text: string;
            score: number;
        }[];
    }>;
    ragIngest(collection: string, documents: {
        id?: string;
        text: string;
    }[]): Promise<{
        ingested: number;
    }>;
    /** Run a bounded agent loop over a prompt template. */
    runAgent(input: {
        prompt_key?: string;
        goal: string;
        variables?: Record<string, unknown>;
        max_steps?: number;
    }): Promise<{
        id: string;
        output: string;
        steps: number;
    }>;
}
