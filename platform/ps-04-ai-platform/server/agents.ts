import type Database from 'better-sqlite3';
import type { ChatMessage, ProviderName } from '../shared/types.js';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import { runChat, type ChatConfig } from './chat.js';

/**
 * A minimal, tool-less agent loop over the chat provider. It seeds a system
 * instruction and the goal, then iterates: each step calls the model with the
 * running transcript and appends the reply. The loop stops when the reply
 * signals completion (contains "DONE") or `max_steps` is reached. Under the
 * default mock provider this is fully deterministic, so agent runs are
 * reproducible offline; a configured vendor makes it a real loop.
 */

export interface RunAgentOptions {
  goal: string;
  promptKey?: string;
  variables?: Record<string, unknown>;
  provider?: ProviderName;
  maxSteps?: number;
  now?: number;
}

export interface AgentRunResult {
  id: number;
  output: string;
  steps: number;
  transcript: ChatMessage[];
}

const MAX_STEPS_CAP = 8;

export async function runAgent(db: Database.Database, config: ChatConfig, opts: RunAgentOptions): Promise<AgentRunResult> {
  const now = opts.now ?? Date.now();
  if (!opts.goal || !opts.goal.trim()) throw new DomainError(422, 'goal is required');
  const maxSteps = Math.min(Math.max(1, opts.maxSteps ?? 3), MAX_STEPS_CAP);

  const transcript: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a task-completing agent. Work toward the goal in short steps. ' +
        'When the goal is fully satisfied, reply with a line that starts with "DONE:" and the final answer.',
    },
    { role: 'user', content: opts.goal.trim() },
  ];

  let steps = 0;
  let output = '';
  for (let i = 0; i < maxSteps; i++) {
    steps++;
    const reply = await runChat(db, config, {
      messages: transcript,
      promptKey: i === 0 ? opts.promptKey : undefined,
      variables: opts.variables,
      provider: opts.provider,
      now,
    });
    output = reply.text;
    transcript.push({ role: 'assistant', content: reply.text });
    if (/(^|\n)\s*DONE:/i.test(reply.text)) break;
    transcript.push({ role: 'user', content: 'Continue toward the goal, or reply "DONE:" with the final answer.' });
  }

  const info = db
    .prepare('INSERT INTO agent_runs (goal, steps, transcript, output, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(opts.goal.trim(), steps, JSON.stringify(transcript), output, nowIso(now));

  return { id: Number(info.lastInsertRowid), output, steps, transcript };
}
