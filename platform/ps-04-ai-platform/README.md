# PS-04 · AI Platform

Shared AI capabilities for the 0815software platform. Modules call one API
for chat, embeddings, retrieval and agents rather than each wiring up its
own model providers and prompt plumbing.

Part of the [Platform Services catalog](../README.md). **Status: Planned —
not yet implemented.** This README documents intended scope only.

## Purpose

Provide a common, provider-agnostic surface for AI features so every module
gets the same capabilities, governance and cost controls.

## Responsibilities

- **Chat** — conversational completions.
- **Embeddings** — vector representations for search and similarity.
- **RAG** — retrieval-augmented generation over module data.
- **AI Agents** — tool-using, multi-step agents.
- **Prompt Management** — versioned, reusable prompts.
- **Image Generation** — text-to-image and edits.
- **Speech** — speech-to-text and text-to-speech.
- **Multiple LLM Providers** — one interface across model vendors.

## Consumed by

Business Modules, over an API. The AI Platform depends on no Business
Module.
