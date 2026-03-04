# Skill Forge — Test Strategy

> Cross-day test framework, mock strategy, and dependency map.
> Reference: sprint-plan.md, prompt-skill-forge-v2.md
> Updated: 2026-03-03 (post-ingestion redesign)

---

## Test Framework

| Layer | Tool | Scope | Speed |
|-------|------|-------|-------|
| Unit | Vitest | Pure functions (turn parsing, graph computation, template fill, JSON validation) | < 2s |
| Integration | Vitest + mock AI / mock Workflow | Agent + SQLite, Workflow steps, WebSocket message routing | < 30s |
| Smoke (manual) | Browser + `npm run dev` | Full round-trip: UI → WebSocket → Agent → Workers AI → UI | Manual, ~5min |

### Vitest Config

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

**Dependencies:** `vitest` (devDependency). No `@cloudflare/vitest-pool-workers` needed — unit tests only test pure functions extracted to files without `cloudflare:workers` imports.

**Key pattern:** Pure functions that need testing are extracted to separate modules (`workflow-helpers.ts`, `graph.ts`) so they can be imported in vitest without triggering Workers runtime dependencies.

---

## Mock Strategy

### Unit Tests — No Mocks Needed

Unit tests cover pure functions only. No Workers AI, Workflow, or WebSocket mocks required:
- `workflow-helpers.ts` — `extractAiResponse`, `parseJsonResponse`, `validateSynthesizedSkill`, `validateSingleVerdict`
- `graph.ts` — `computeGraphData`
- `prompts.ts` — `fillTemplate`, prompt constants
- `components/IngestionPanel.tsx` — `parseConversationTurns`, `speakerVariant`

### Integration Tests — Mock AI + Workflow (if needed)

For future integration tests that test Agent handlers end-to-end:

```typescript
// test/mocks/ai.ts
export function createMockAI(responses: Record<string, string>) {
  return {
    run: async (model: string, options: any) => {
      const key = options.messages?.[1]?.content?.slice(0, 50) || "default";
      const matched = Object.entries(responses).find(([k]) => key.includes(k));
      const text = matched?.[1] || '[]';
      return { response: text };
    }
  };
}
```

```typescript
// test/mocks/connection.ts
export function createMockConnection() {
  const sent: string[] = [];
  return {
    id: "test-conn-1",
    send: (data: string) => sent.push(data),
    _sent: sent,
    _parsed: () => sent.map(s => JSON.parse(s)),
  };
}
```

---

## Cross-Day Dependency Map

```
Day 1 ─────────────────────────────────────────────────────
  │  Gate: TypeScript compiles, npm run dev starts,
  │        chat round-trip works, SQL tables exist
  │
  ├──→ Day 2 ──────────────────────────────────────────────
  │      │  Gate: Turn parsing works, 3-step Workflow
  │      │        executes, IngestionPanel renders,
  │      │        synthesize → crossref → draft end-to-end
  │      │
  │      ├──→ Day 3 ───────────────────────────────────────
  │      │      │  Gate: Skill CRUD works in SQLite,
  │      │      │        refine tool produces updated draft,
  │      │      │        search returns saved skill
  │      │      │
  │      │      ├──→ Day 4 ────────────────────────────────
  │      │      │      │  Gate: computeGraphData() correct
  │      │      │      │        for 5+ skills, D3 renders,
  │      │      │      │        click/hover interactions work
  │      │      │      │
  │      │      │      └──→ Day 5 ─────────────────────────
  │      │      │             Gate: Production deploy works,
  │      │      │             all smoke tests pass on prod URL
  │      │      │
  │      │      └──→ Day 4 (also depends on Day 1 state sync)
  │      │
  │      └──→ Day 3 (also depends on Day 1 Agent + SQL)
  │
  └──→ Day 4 (direct: Agent state + computeGraphData uses Day 1 infra)
```

### Hard Dependencies (must pass before proceeding)

| Day | Blocked By | Required Gate |
|-----|-----------|---------------|
| 2 | Day 1 | Agent starts, SQL schema created, WebSocket connects, frontend renders |
| 3 | Day 1 + Day 2 | Ingestion pipeline produces draft skills (input for refinement) |
| 4 | Day 1 + Day 3 | Skills exist in SQLite (input for graph rendering) |
| 5 | Days 1-4 | All core features functional |

### Soft Dependencies (can work around with seed data)

| Day | Can Start Early If... |
|-----|----------------------|
| 3 | Manually insert test skills into SQLite (bypass Day 2 pipeline) |
| 4 | Manually insert 5+ skills into SQLite (bypass Day 2-3) |

---

## Test File Organization

```
test/
├── workflow.test.ts        # extractAiResponse, parseJsonResponse, validateSynthesizedSkill, validateSingleVerdict
├── prompts.test.ts         # fillTemplate, prompt constant exports
├── graph.test.ts           # computeGraphData (nodes, edges, colors, sizes)
└── ingestion-panel.test.ts # parseConversationTurns, speakerVariant
```

Source modules tested (pure functions extracted for testability):
```
src/
├── workflow-helpers.ts     # Pure helpers (no cloudflare:workers import)
├── graph.ts                # computeGraphData (extracted from server.ts)
├── prompts.ts              # fillTemplate + prompt constants
└── components/
    └── IngestionPanel.tsx   # parseConversationTurns, speakerVariant
```

---

## Running Tests

```bash
# All unit tests
npm test

# Watch mode during development
npx vitest

# Full check (format + lint + typecheck)
npm run check

# Smoke tests — manual, follow checklist
npm run dev
# Then open browser and follow docs/test/dayN test plan
```

---

## Current Test Coverage (81 tests)

| File | Tests | Status |
|------|-------|--------|
| `test/workflow.test.ts` | 39 | PASS |
| `test/ingestion-panel.test.ts` | 18 | PASS |
| `test/prompts.test.ts` | 13 | PASS |
| `test/graph.test.ts` | 11 | PASS |
