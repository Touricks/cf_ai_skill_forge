# Day 5 Test Plan — Polish + README + Deploy

> Covers tasks 5.1–5.7 from sprint-plan.md
> Dependencies: Days 1-4 (all core features must be functional)
> Updated: 2026-03-03 (post-ingestion redesign — turn selection replaces pattern cards)

---

## Unit Tests

### U5.1 — Error message routing (Task 5.1)

```
TEST: Ingestion error arrives via onMessage as IngestionAgentMessage
INPUT: IngestionAgentMessage { type: "error", message: "Pipeline failed" }
PASS:  Frontend routes to Ingestion Panel error display (not chat)

TEST: Chat error is handled by streamText error handling in the framework
NOTE: Chat errors (LLM timeout, etc.) are caught by the AIChatAgent framework's
      streamText error handler. The frontend displays these via useAgentChat's
      built-in error state — no custom "source" field needed.
PASS:  Chat panel displays error message from framework error handling

TEST: Ingestion error without message field defaults gracefully
INPUT: IngestionAgentMessage { type: "error" }
PASS:  Falls back to generic "An error occurred" in Ingestion Panel
```

---

## Integration Tests

### I5.1 — Network disconnect + reconnect (Task 5.1)

```
TEST: WebSocket reconnects after temporary disconnect
SETUP: Establish connection, simulate network drop
RUN:   Wait for reconnect
CHECK: State is restored (skills, chat history, graph)
PASS:  User sees their data after reconnect, no data loss

TEST: Pending ingestion status recovers
SETUP: Start ingestion → disconnect → reconnect
CHECK: ingestionStatus reflects actual pipeline state
PASS:  User can see if ingestion completed or needs re-trigger
```

### I5.2 — Empty repository experience (Task 5.3)

```
TEST: New user sees onboarding state
SETUP: Fresh Agent instance (no skills, no chat history)
CHECK: Chat panel: suggestion prompts visible ("What skills do I have?", etc.)
CHECK: Graph panel: "No skills yet" message (not blank/broken)
CHECK: Ingestion panel: clear call-to-action to paste first conversation
PASS:  Every panel has a meaningful empty state
```

### I5.3 — Loading states during streaming (Task 5.2)

```
TEST: Chat shows loading indicator while AI responds
RUN:   Send chat message
CHECK: Loading/typing indicator visible between send and first chunk
CHECK: Indicator disappears when streaming begins
PASS:  No blank gap between send and response

TEST: Ingestion shows progress for each pipeline step
RUN:   Start ingestion
CHECK: Progress bar updates as each Workflow step completes
       (synthesize → crossref → draft)
PASS:  User knows the pipeline is working (not frozen)
```

---

## Smoke Tests (Manual — Browser)

### S5.1 — Error state: network timeout (Task 5.1)

```
RUN:    Stop `npm run dev` while app is open
CHECK:  UI shows connection lost indicator (not blank screen)
CHECK:  Attempting to send message shows "Disconnected" or similar
RUN:    Restart `npm run dev`
CHECK:  App reconnects and restores state
PASS:   Graceful handling of server unavailability
```

### S5.2 — Error state: Workers AI failure (Task 5.1)

```
RUN:    Send a chat message (if Workers AI rate-limited or down)
CHECK:  Error message displayed in chat: "LLM failed: ..."
CHECK:  App remains functional (not crashed)
CHECK:  Can retry sending a message
PASS:   LLM errors are caught and surfaced
```

### S5.3 — Loading skeletons (Task 5.2)

```
RUN:    Hard refresh the page
CHECK:  Skeleton loading states visible briefly while Agent state loads
CHECK:  No layout shift when real data arrives
PASS:   Smooth loading experience
```

### S5.4 — Empty state: fresh user (Task 5.3)

```
SETUP:  Use incognito window or new Agent instance name
CHECK:  Suggestion prompts in chat area ("What skills do I have?", etc.)
CHECK:  Empty graph with "no skills" message
CHECK:  Ingestion panel shows clear CTA
PASS:   First-time user knows what to do
```

### S5.5 — Dark theme consistency (Task 5.5)

```
CHECK:  All UI elements use dark theme (no white backgrounds anywhere)
CHECK:  Scrollbars are dark-themed (or auto-themed by OS)
CHECK:  Tooltips, modals, dropdowns all respect dark palette
CHECK:  Text contrast is sufficient (WCAG AA on #0a0a0a background)
CHECK:  Cloudflare orange (#f97316) used sparingly as accent
PASS:   Consistent dark theme throughout
```

### S5.6 — Responsive behavior (Task 5.5)

```
RUN:    Resize browser window to < 768px width
CHECK:  Left panel stacks above right panel (not side-by-side)
CHECK:  Chat remains usable at narrow width
CHECK:  Graph is still visible (may be below chat)
PASS:   Not broken on narrow screens (desktop-first but not desktop-only)
```

### S5.7 — README completeness (Task 5.6)

```
CHECK:  README includes:
  [ ] Project overview (what Skill Forge does)
  [ ] Architecture diagram or description
  [ ] Setup instructions (npm install, wrangler config)
  [ ] How to run locally (npm run dev)
  [ ] How to deploy (npx wrangler deploy)
  [ ] Architecture decisions:
      [ ] Why Agent SDK + Workflows (not just one or the other)
      [ ] Why embedded SQLite (not D1 + KV)
      [ ] Why separate Ingestion Panel from Chat
  [ ] Screenshots or GIFs showing the app in action
PASS:   Reviewer can understand architecture in 10 minutes
```

### S5.8 — Production deployment (Task 5.7)

```
RUN:    npx wrangler deploy
CHECK:  Deployment succeeds without errors
CHECK:  Terminal shows production URL

RUN:    Open production URL in browser
CHECK:  App loads (dark theme, two-panel layout)
CHECK:  Chat works (streaming response from Workers AI)
CHECK:  Ingestion works (paste → parse turns → select → extract → approve)
CHECK:  Skills persist (save → refresh → still there)
CHECK:  Graph renders (if skills exist)
PASS:   Production deployment is fully functional
```

### S5.9 — Full end-to-end regression (all days)

```
On production URL, run through the complete user journey:

1. Open app → see empty state / suggestion prompts
2. Open ingestion panel → paste a real conversation → "Parse Turns"
3. Turn selection UI → select turns within token budget
4. Add skill hint → "Extract Skill" → progress bar shows 3 steps
5. Draft skill appears → review name, description, key decisions, markdown
6. Click "Approve & Save" → skill saved to repository
7. In chat, ask "What skills do I have?" → LLM calls listSkills, shows saved skill
8. In chat, give feedback → LLM calls refineSkill, shows updated content
9. Repeat steps 2-6 with 2 more conversations (total 3+ skills)
10. Check graph → 3+ nodes, edges visible
11. Click node → skill detail shown
12. Hover node → tooltip appears
13. Search for keyword → finds relevant skill
14. Close tab → reopen → all data persists
15. Delete a skill → removed from graph and search

PASS:  All 15 steps succeed on production.
```

---

## Day 5 Gate (final — project complete)

| # | Criterion | Test |
|---|-----------|------|
| G5.1 | Error states don't crash the app | S5.1, S5.2 |
| G5.2 | Empty states are meaningful | S5.4 |
| G5.3 | Dark theme is consistent | S5.5 |
| G5.4 | README explains architecture decisions | S5.7 |
| G5.5 | Production deploy works | S5.8 |
| G5.6 | Full end-to-end regression passes on production | S5.9 |

**All 6 gates must pass for project submission.**

---

## Assignment Requirement Verification

Final check that the 4 required Cloudflare components are demonstrably used:

| Requirement | Verified By |
|-------------|------------|
| LLM integration | S5.9 step 5 (synthesis) + step 8 (refinement) + step 13 (search) |
| Workflow / coordination | S5.9 step 4 (ingestion pipeline with 3 steps: synthesize → crossref → draft) |
| User input (chat) | S5.9 step 7-8 (chat tools: listSkills, refineSkill, searchSkills) |
| Memory / state | S5.9 step 14 (close tab → reopen → data persists via SQLite) |
