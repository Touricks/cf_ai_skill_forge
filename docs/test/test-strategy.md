# Skill Forge — Test Strategy

> Cross-day test framework, mock strategy, and dependency map.
> Reference: sprint-plan.md, prompt-skill-forge-v2.md

---

## Test Framework

| Layer | Tool | Scope | Speed |
|-------|------|-------|-------|
| Unit | Vitest | Pure functions (chunking, graph computation, template fill, JSON validation) | < 5s |
| Integration | Vitest + `unstable_dev` / Miniflare | Agent + SQLite, Workflow steps, WebSocket message routing | < 30s |
| Smoke (manual) | Browser + `wrangler dev` | Full round-trip: UI → WebSocket → Agent → Workers AI → UI | Manual, ~5min |

### Vitest Config (Day 1 setup)

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "miniflare",   // Cloudflare Workers runtime emulation
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
```

**Dependencies:** `vitest`, `@cloudflare/vitest-pool-workers` (for Workers-compatible test environment).

---

## Mock Strategy

### Workers AI Mock

Unit and integration tests must NOT call real Workers AI. Use a mock that returns canned responses:

```typescript
// test/mocks/ai.ts
export function createMockAI(responses: Record<string, string>) {
  return {
    run: async (model: string, options: any) => {
      const key = options.messages?.[1]?.content?.slice(0, 50) || "default";
      const matched = Object.entries(responses).find(([k]) => key.includes(k));
      const text = matched?.[1] || '[]';

      if (options.stream) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"response":"${text}"}\n\n`));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
      }
      return { response: text };
    }
  };
}
```

### Workflow Mock

For testing Agent → Workflow trigger without running the full Workflow:

```typescript
// test/mocks/workflow.ts
export function createMockWorkflow() {
  const instances: any[] = [];
  return {
    create: async (params: any) => {
      instances.push(params);
      return { id: "mock-workflow-id" };
    },
    get: async (id: string) => ({
      status: { status: "complete" },
    }),
    _instances: instances,  // test inspection
  };
}
```

### WebSocket Mock

For testing Agent `onMessage` routing without a real browser:

```typescript
// test/mocks/connection.ts
export function createMockConnection() {
  const sent: string[] = [];
  return {
    id: "test-conn-1",
    send: (data: string) => sent.push(data),
    _sent: sent,              // test inspection
    _parsed: () => sent.map(s => JSON.parse(s)),
  };
}
```

---

## Cross-Day Dependency Map

```
Day 1 ─────────────────────────────────────────────────────
  │  Gate: TypeScript compiles, wrangler dev starts,
  │        chat round-trip works, SQL tables exist
  │
  ├──→ Day 2 ──────────────────────────────────────────────
  │      │  Gate: chunkConversation() passes unit tests,
  │      │        Workflow steps execute with mock AI,
  │      │        Ingestion Panel renders and sends messages
  │      │
  │      ├──→ Day 3 ───────────────────────────────────────
  │      │      │  Gate: Skill CRUD works in SQLite,
  │      │      │        refine loop produces updated draft,
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
├── mocks/
│   ├── ai.ts               # Workers AI mock
│   ├── workflow.ts          # Workflow mock
│   └── connection.ts        # WebSocket connection mock
├── fixtures/
│   ├── conversations/       # Sample conversation texts for ingestion
│   │   ├── react-debug.md
│   │   ├── api-design.md
│   │   └── short-fragment.md
│   ├── patterns/            # Expected extraction results
│   │   └── react-debug-patterns.json
│   └── skills/              # Sample skill definitions
│       ├── react-state-migration.md
│       └── api-error-handling.md
├── unit/
│   ├── chunking.test.ts     # Day 2: chunkConversation()
│   ├── prompts.test.ts      # Day 1: fillTemplate()
│   ├── graph.test.ts        # Day 4: computeGraphData()
│   ├── validation.test.ts   # Day 2: JSON parse + field validation
│   └── commands.test.ts     # Day 3: /ingest, /search parsing
├── integration/
│   ├── agent-sql.test.ts    # Day 1: schema init, CRUD
│   ├── agent-chat.test.ts   # Day 1: chat message routing
│   ├── workflow.test.ts     # Day 2: pipeline steps with mock AI
│   ├── ingestion.test.ts    # Day 2: Agent triggers Workflow
│   ├── refinement.test.ts   # Day 3: refine loop
│   ├── search.test.ts       # Day 3: SQL + LLM search
│   └── state-sync.test.ts   # Day 4: graph data in state
└── smoke/
    ├── day1-checklist.md     # Manual browser test script
    ├── day2-checklist.md
    ├── day3-checklist.md
    ├── day4-checklist.md
    └── day5-checklist.md
```

---

## Running Tests

```bash
# Unit tests only (fast, no network)
npx vitest run test/unit/

# Integration tests (needs miniflare)
npx vitest run test/integration/

# All automated tests
npx vitest run

# Watch mode during development
npx vitest

# Smoke tests — manual, follow checklist
npx wrangler dev
# Then open browser and follow docs/test/dayN-checklist
```
