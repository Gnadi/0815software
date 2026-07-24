import { BaseClient } from './http.js';
/** Client for PS-04 AI Platform (default port 4004). */
export class AiClient extends BaseClient {
    chat(input) {
        return this.apiPost('/api/chat/completions', input);
    }
    embed(input) {
        return this.apiPost('/api/embeddings', input);
    }
    ragSearch(input) {
        return this.apiPost('/api/rag/search', input);
    }
    ragIngest(collection, documents) {
        return this.apiPost('/api/rag/documents', { collection, documents });
    }
    /** Run a bounded agent loop over a prompt template. */
    runAgent(input) {
        return this.apiPost('/api/agents/run', input);
    }
}
