# User Message
When user initialize a project, how to manage the document to make AI reliable and consist to initial plan in theprocessing of implementation.  

# AI Message 
Here's the practical framework for keeping AI reliable during implementation:

## Core Architecture: Write/Read Layer Separation

The key insight is: **don't let AI face raw, unprocessed document history**. Instead, separate information into two layers:

### 1. Write Layer (`docs_human/`)
- Where humans freely create docs: design docs, meeting notes, PRD changes, decision records
- Preserves full history and reasoning ("why option A, not B")
- **AI should NOT treat this as current truth** — it contains evolution, not just final state

### 2. Read Layer (root `CLAUDE.md`, ≤200 lines)
- A compacted **current-state snapshot** — "what a new team member needs to know today"
- Only contains: invariants, current architecture state, active iteration, verified constraints
- This is what AI reads at session start to orient itself

### 3. Feedback Channel (`PROGRESS.md`)
- AI writes back constraints discovered during execution (test failures, infeasible approaches)
- These get compacted into the read layer at review cycles

## Three Mechanisms to Prevent Drift

**A. Chain-Triggered Updates** (high-frequency, small changes)
```
File changed → update file header → update folder CLAUDE.md → flag root CLAUDE.md
```
Every file declares its `input/output/pos`. AI sees the update obligation every time it reads a file — the reminder lives at the work site, not in a distant rules doc.

**B. Periodic Compaction** (low-frequency, architectural changes)
- Triggered at: sprint end, architecture decision finalized, or manual `/compact`
- Input: current CLAUDE.md + incremental new docs since last compaction
- Output: updated CLAUDE.md snapshot
- Reviewed via changelog (like code review reviews diffs, not the whole repo)

**C. Plan Rebuilding, Not Plan Recovery**
This is the most counterintuitive part: **don't persist plans, rebuild them**. A saved plan starts decaying the moment it's written (tasks done, approaches changed, items abandoned). Instead:
- New session reads the three-layer docs (root snapshot → module index → file headers)
- Infers "where am I now, what's next" from **actual code state**, not stale plans

## Practical Setup at Project Init

```
project/
├── CLAUDE.md              ← Read layer: ≤200 lines, current truth
├── PROGRESS.md            ← Feedback channel: AI writes constraints here
├── .claude/rules/         ← Update obligations as code (not docs)
├── docs_human/            ← Write layer: full history, human-friendly
│   ├── CLAUDE.md          ← Index of write layer categories
│   ├── Research/
│   ├── Design/
│   ├── PRD/
│   └── Notes/
└── src/
    ├── CLAUDE.md          ← Module index: ≤3 lines + file list
    └── module/
        └── file.py        ← Header: input/output/pos (3 lines)
```

## The Consistency Guarantee

The system works because:

1. **AI always starts from compacted current truth** (not raw history)
2. **Chain-triggered updates keep local docs fresh** after each change
3. **Execution feedback loops back** through PROGRESS.md → compaction → CLAUDE.md
4. **Hooks enforce what declarations can't** — git commit hook warns if changed files didn't update their folder's CLAUDE.md

The underlying principle from your paper: **information consumed by AI must be pre-processed and dimensionally reduced** — whether that's tool routing (MCP) or context understanding (document management). Don't ask AI to distill from the ocean; give it a curated glass of water.

# User Message
What if user want to change some feature when claude implement something and found some of the initial features is unavailable? 

# AI Message
This is exactly the scenario the **feedback loop** is designed for. The failure mode to avoid: AI keeps executing the original plan while reality has diverged.

## The Problem in Practice

```
Original plan: Feature A + B + C
During implementation: B turns out infeasible
Without feedback loop: AI finishes A, tries B, fails, retries B, wastes context
With feedback loop: AI records B's infeasibility, user adjusts scope, AI rebuilds plan
```

## How the Three-Layer System Handles This

### Step 1: AI discovers the constraint during execution
Write it to `PROGRESS.md` immediately — don't wait for compaction:

```markdown
## Discovered Constraints

- [2026-03-04] Feature B (real-time sync) infeasible: 
  library X doesn't support WebSocket in current stack.
  Impact: Design/sync-architecture.md assumptions invalidated.
  Alternatives considered: polling (viable), SSE (viable).
```

### Step 2: Human makes the decision
This is critical — **the AI surfaces the constraint, the human decides the direction**. The user might:
- Drop feature B entirely
- Replace B with a simpler alternative
- Change the tech stack to make B possible

This decision goes into the write layer (`docs_human/`) as a decision record.

### Step 3: Update the read layer
After the decision, update root `CLAUDE.md`:

```markdown
## Current Iteration
- Sprint goal: Feature A + C (B dropped — see PROGRESS.md)
- Active change: replacing sync architecture with polling
```

### Step 4: Next session rebuilds, not recovers
The next AI session reads the updated `CLAUDE.md`, sees the current state, and plans from reality — not from the stale original plan.

## The Key Principle

Your paper's insight applies directly here: **don't recover the plan, rebuild it.**

A persisted plan that says "implement A, B, C" becomes a liability once B is dropped. If the AI recovers this plan, it sees B as "pending." If it rebuilds from current state (CLAUDE.md says "A done, B dropped, C next"), it gets the right picture.

## Practical Workflow

```
User: "Actually, let's drop feature B and do D instead"
     ↓
1. AI writes constraint to PROGRESS.md (why B failed)
2. Human/AI updates CLAUDE.md current iteration section
3. If in same session: AI adjusts immediately
4. If new session: AI reads updated CLAUDE.md, 
   never even knows B was planned
```

The document system acts as a **single-writer truth store** — the read layer always reflects the latest agreed-upon reality, so AI never argues with a stale plan. The write layer preserves the history of *why* B was dropped, which matters for humans but not for the AI's current task.