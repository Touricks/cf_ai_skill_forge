# Task 6 — `/copy k` Command: Chat-to-Ingestion Flow

> Prereq: Days 1-5 complete. Ingestion pipeline, chat tools, graph visualization all functional.
> Reference: integration-test-plan.md (IT-1), prompt-skill-forge-v2.md (Section 6)

---

## Goal

Add a `/copy k` command that takes the last K turns from the active chat and pre-fills the Ingestion Panel, enabling seamless chat-to-ingestion flow. This solves two problems:
1. No easy way to ingest current chat conversations (users had to manually copy-paste)
2. External conversation formats (markdown headers) don't match the parser's expected `Speaker:` format

## Background

The `parseConversationTurns()` regex expects `Speaker:` format (`User: hello`). When users paste from external sources with different formats (e.g., `# User Message`), the parser treats the entire text as 1 "Unknown" turn.

By generating the text from our own `messages` array, we control the format and guarantee parser compatibility.

---

## Step 6.1 — Intercept `/copy k` in Chat Input

**File: `src/app.tsx`**

In the `send()` callback, add a regex check before `sendMessage()`:

```typescript
const copyMatch = text.match(/^\/copy\s+(\d+)$/i);
if (copyMatch) {
  handleCopyToIngestion(parseInt(copyMatch[1], 10));
  setInput("");
  return; // Don't send as chat message
}
```

This intercepts the command client-side — it never reaches the server.

## Step 6.2 — `formatLastKTurns()` Utility

**File: `src/app.tsx`**

Add a utility function that extracts text from the `UIMessage[]` array:

```typescript
function formatLastKTurns(messages: UIMessage[], k: number): string | null {
  const recent = messages.slice(-(k * 2));
  if (recent.length === 0) return null;

  return recent
    .map((msg) => {
      const textParts = msg.parts.filter((p) => p.type === "text");
      const text = textParts.map((p) => (p as { text: string }).text).join("\n");
      if (!text) return null;
      const speaker = msg.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}
```

Output format: `User: ...\n\nAssistant: ...\n\n...` — directly compatible with `parseConversationTurns`.

## Step 6.3 — Add `prefillContent` Prop to IngestionPanel

**File: `src/components/IngestionPanel.tsx`**

Add two props:
- `prefillContent: string | null` — the formatted text to pre-fill
- `onPrefillConsumed: () => void` — callback to clear the prop after consuming

Add a `useEffect` that auto-opens the panel and fills the textarea:

```typescript
useEffect(() => {
  if (prefillContent) {
    setContent(prefillContent);
    setIsOpen(true);
    onPrefillConsumed();
  }
}, [prefillContent]);
```

**File: `src/app.tsx`**

Add state and handler:
```typescript
const [prefillContent, setPrefillContent] = useState<string | null>(null);

const handleCopyToIngestion = useCallback((k: number) => {
  const formatted = formatLastKTurns(messages, k);
  if (formatted) setPrefillContent(formatted);
}, [messages]);
```

Pass to IngestionPanel:
```typescript
<IngestionPanel
  ...existing props
  prefillContent={prefillContent}
  onPrefillConsumed={() => setPrefillContent(null)}
/>
```

## Step 6.4 — Edge Cases

| Input | Behavior |
|-------|----------|
| `/copy 0` | `formatLastKTurns` returns `null` → no action |
| `/copy 99` (more than available) | `messages.slice(-198)` returns all messages → pre-fills all available turns |
| No messages yet | Returns `null` → no action |
| Messages with only tool parts (no text) | Filtered out by `textParts.length === 0` check |

---

## Bug Fix (also in this commit)

**Delete skill field mismatch** — `app.tsx:158` sent `{ type: "delete_skill", name }` but `types.ts` and `server.ts` expected `skillName`. Fixed: `name` → `skillName: name`.
