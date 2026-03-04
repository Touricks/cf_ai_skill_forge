# Skill Forge — Auto Memory

## Project Setup
- Starter: `cloudflare/agents-starter` (March 2026) with AIChatAgent + kumo + Vite 7
- Auth: OAuth via `npx wrangler login`, account `f36meng@gmail.com`
- AI binding: `remote: true` — local dev calls Cloudflare AI API remotely

## Key Patterns
- Dual-channel WebSocket: `useAgentChat` (chat) + `useAgent` (ingestion)
- Agent extends `AIChatAgent<Env>`, NOT raw `Agent`
- Chat tools via `tool()` from Vercel AI SDK, NOT custom message types
- Workflow uses `env.AI.run()`, Agent uses `streamText()`

## Files to Know
- `agents-starter/src/server.ts` — Agent class
- `agents-starter/src/app.tsx` — React frontend
- `agents-starter/wrangler.jsonc` — bindings config
- `docs/task1-initialization.md` — Day 1 execution plan (updated to match reality)
