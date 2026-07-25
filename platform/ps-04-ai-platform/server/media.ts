import { createHash } from 'node:crypto';
import type { FetchLike } from './providers/index.js';

/**
 * Image generation and speech transcription.
 *
 * Both default to a deterministic, offline mock so the endpoints are usable
 * in tests and CI with zero external calls. A real vendor adapter (OpenAI) is
 * used only when its API key is configured — the same "adapter-optional"
 * pattern as the chat providers.
 */

export interface ImageResult {
  provider: string;
  model: string;
  /** A data: URI (mock) or a hosted URL (real vendor). */
  image: string;
}

/** Deterministic placeholder image: an SVG data URI derived from the prompt. */
export function mockImage(prompt: string): ImageResult {
  const digest = createHash('sha256').update(prompt).digest('hex');
  const hue = parseInt(digest.slice(0, 2), 16) * (360 / 255);
  const hue2 = parseInt(digest.slice(2, 4), 16) * (360 / 255);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue.toFixed(0)},70%,55%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue2.toFixed(0)},70%,45%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="256" height="256" fill="url(#g)"/>` +
    `<text x="128" y="240" font-family="monospace" font-size="10" fill="#fff" text-anchor="middle">${digest.slice(0, 16)}</text>` +
    `</svg>`;
  return { provider: 'mock', model: 'mock-image-001', image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
}

export async function generateImage(
  prompt: string,
  cfg: { openaiApiKey: string | null; imageModel: string; fetchImpl: FetchLike },
): Promise<ImageResult> {
  if (!cfg.openaiApiKey) return mockImage(prompt);
  const res = await cfg.fetchImpl('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({ model: cfg.imageModel, prompt, n: 1 }),
  });
  if (!res.ok) throw new Error(`image generation failed (${res.status})`);
  const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
  const first = data.data?.[0];
  const image = first?.url ?? (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
  return { provider: 'openai', model: cfg.imageModel, image };
}

export interface TranscriptResult {
  provider: string;
  model: string;
  text: string;
}

/** Deterministic mock transcript derived from a supplied reference/text. */
export function mockTranscribe(ref: string): TranscriptResult {
  const digest = createHash('sha256').update(ref).digest('hex').slice(0, 8);
  return { provider: 'mock', model: 'mock-transcribe-001', text: `[mock transcript ${digest}] ${ref.slice(0, 200)}` };
}

export async function transcribe(
  ref: string,
  cfg: { openaiApiKey: string | null; speechModel: string; fetchImpl: FetchLike },
): Promise<TranscriptResult> {
  if (!cfg.openaiApiKey) return mockTranscribe(ref);
  // A real deployment streams the audio bytes; here we forward a reference.
  const res = await cfg.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({ model: cfg.speechModel, input: ref }),
  });
  if (!res.ok) throw new Error(`transcription failed (${res.status})`);
  const data = (await res.json()) as { text?: string };
  return { provider: 'openai', model: cfg.speechModel, text: data.text ?? '' };
}
