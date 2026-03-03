# Day 5 Test Plan — Polish + README + Deploy

> Covers tasks 5.1–5.7 from sprint-plan.md
> Dependencies: Days 1-4 (all core features must be functional)

---

## Unit Tests

### U5.1 — Error message routing (Task 5.1)

```
TEST: Error with source "ingestion" targets Ingestion Panel
INPUT: AgentMessage { type: "error", message: "Pipeline failed", source: "ingestion" }
PASS:  Frontend routes to Ingestion Panel error display (not chat)

TEST: Error with source "chat" targets Chat Panel
INPUT: AgentMessage { type: "error", message: "LLM timeout", source: "chat" }
PASS:  Frontend routes to Chat Panel (displayed as system message)

TEST: Error without source defaults to chat
INPUT: AgentMessage { type: "error", message: "Unknown error" }
PASS:  Falls back to Chat Panel display
```

### U5.2 — File format auto-detection (Task 5.4)

```
TEST: .md file detected as markdown
INPUT: File named "conversation.md"
PASS:  Returns format: "markdown"

TEST: .json file detected as JSON
INPUT: File named "export.json"
PASS:  Returns format: "json"

TEST: .txt file detected as plain text
INPUT: File named "chat.txt"
PASS:  Returns format: "text"

TEST: Unknown extension defaults to plain text
INPUT: File named "chat.log"
PASS:  Returns format: "text" (graceful fallback)
```

### U5.3 — Multi-file batch validation (Task 5.4)

```
TEST: Multiple files accepted
INPUT: 3 files selected via file picker
PASS:  All 3 processed, results aggregated

TEST: Mixed valid + invalid files → partial success
INPUT: 2 valid .md files + 1 binary .png file
PASS:  2 files ingested, 1 skipped with warning message
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
CHECK: Chat panel: welcome message or empty state prompt
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
CHECK: Progress bar or step indicator updates as each Workflow step completes
PASS:  User knows the pipeline is working (not frozen)
```

---

## Smoke Tests (Manual — Browser)

### S5.1 — Error state: network timeout (Task 5.1)

```
RUN:    Stop `wrangler dev` while app is open
CHECK:  UI shows connection lost indicator (not blank screen)
CHECK:  Attempting to send message shows "Disconnected" or similar
RUN:    Restart `wrangler dev`
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
CHECK:  Onboarding message in chat area
CHECK:  Empty graph with "no skills" message
CHECK:  Ingestion panel shows clear CTA
PASS:   First-time user knows what to do
```

### S5.5 — Multi-file batch upload (Task 5.4)

```
RUN:    Select 3 .md files via file picker in Ingestion Panel
CHECK:  All 3 files queued for ingestion
CHECK:  Progress shows per-file status
CHECK:  Results aggregated (patterns from all 3 conversations)
PASS:   Batch upload works
```

### S5.6 — Dark theme consistency (Task 5.5)

```
CHECK:  All UI elements use dark theme (no white backgrounds anywhere)
CHECK:  Scrollbars are dark-themed (or auto-themed by OS)
CHECK:  Tooltips, modals, dropdowns all respect dark palette
CHECK:  Text contrast is sufficient (WCAG AA on #0a0a0a background)
CHECK:  Cloudflare orange (#f97316) used sparingly as accent
PASS:   Consistent dark theme throughout
```

### S5.7 — Responsive behavior (Task 5.5)

```
RUN:    Resize browser window to < 768px width
CHECK:  Left panel stacks above right panel (not side-by-side)
CHECK:  Chat remains usable at narrow width
CHECK:  Graph is still visible (may be below chat)
PASS:   Not broken on narrow screens (desktop-first but not desktop-only)
```

### S5.8 — README completeness (Task 5.6)

```
CHECK:  README includes:
  [ ] Project overview (what Skill Forge does)
  [ ] Architecture diagram or description
  [ ] Setup instructions (npm install, wrangler config)
  [ ] How to run locally (npx wrangler dev)
  [ ] How to deploy (npx wrangler deploy)
  [ ] Architecture decisions:
      [ ] Why Agent SDK + Workflows (not just one or the other)
      [ ] Why embedded SQLite (not D1 + KV)
      [ ] Why separate Ingestion Panel from Chat
  [ ] Screenshots or GIFs showing the app in action
PASS:   Reviewer can understand architecture in 10 minutes
```

### S5.9 — Production deployment (Task 5.7)

```
RUN:    npx wrangler deploy
CHECK:  Deployment succeeds without errors
CHECK:  Terminal shows production URL

RUN:    Open production URL in browser
CHECK:  App loads (dark theme, two-panel layout)
CHECK:  Chat works (streaming response from Workers AI)
CHECK:  Ingestion works (paste → patterns → draft)
CHECK:  Skills persist (save → refresh → still there)
CHECK:  Graph renders (if skills exist)
CHECK:  /api/health returns {"status":"ok",...}
PASS:   Production deployment is fully functional
```

### S5.10 — Full end-to-end regression (all days)

```
On production URL, run through the complete user journey:

1. Open app → see empty state / onboarding
2. Expand ingestion panel → paste a real conversation → Start Analysis
3. Wait for pipeline → pattern cards appear
4. Confirm patterns → draft skill appears
5. In chat, give feedback → skill refines
6. Approve skill → saved to repository
7. Repeat steps 2-6 with 2 more conversations (total 3+ skills)
8. Check graph → 3+ nodes, edges visible
9. Click node → skill detail shown
10. Hover node → tooltip appears
11. Filter by tag → correct nodes highlighted
12. "/search [keyword]" → finds relevant skill
13. "/skills" → lists all skills
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
| G5.3 | Dark theme is consistent | S5.6 |
| G5.4 | README explains architecture decisions | S5.8 |
| G5.5 | Production deploy works | S5.9 |
| G5.6 | Full end-to-end regression passes on production | S5.10 |

**All 6 gates must pass for project submission.**

---

## Assignment Requirement Verification

Final check that the 4 required Cloudflare components are demonstrably used:

| Requirement | Verified By |
|-------------|------------|
| LLM integration | S5.10 step 3 (extraction) + step 5 (refinement) + step 12 (search) |
| Workflow / coordination | S5.10 step 2-4 (ingestion pipeline with 4 steps + retry) |
| User input (chat) | S5.10 step 5 (chat refinement) + step 12-13 (commands) |
| Memory / state | S5.10 step 14 (close tab → reopen → data persists via SQLite) |
