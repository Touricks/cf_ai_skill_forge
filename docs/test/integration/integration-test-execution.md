# Integration Test Execution Checklist

> Executed via Playwright MCP against `localhost:5173`
> Test data: `test/test_example.md`

## IT-1: Ingestion E2E (via /copy 2)

- [ ] App loaded, "Connected", "No skills yet"
- [ ] Send prompt 1 → response streams
- [ ] Send prompt 2 → response streams
- [ ] Type `/copy 2` → Ingestion Panel opens, textarea pre-filled (User/Assistant format)
- [ ] Click "Parse Turns" → 4 turns with correct speakers
- [ ] Add skill hint → Click "Extract Skill" → progress bar advances
- [ ] Draft appears with name, tags, description, key decisions
- [ ] Click "Approve & Save" → graph shows new node, tag chips appear

## IT-2: Chat Tools Chain

- [ ] "What skills do I have?" → listSkills triggered, skill returned
- [ ] "Show me [name]" → viewSkill triggered, full content
- [ ] "Search for document management" → searchSkills triggered, results

## IT-3: Graph State Sync

- [ ] Graph has 1 node
- [ ] Click node → SkillPreview shows name/tags/description
- [ ] Click "Back to graph" → returns to graph

## IT-5: Persistence

- [ ] Refresh page → graph node still present
- [ ] "What skills do I have?" → skill still returned

## IT-3.5: Delete Skill

- [ ] Click node → SkillPreview → "Delete Skill"
- [ ] Node removed, "No skills yet" shown

## IT-6: Error Resilience

- [ ] Paste "hello" → Parse → Extract → error, panel ok
- [ ] "Show me nonexistent-skill" → not found, chat continues
