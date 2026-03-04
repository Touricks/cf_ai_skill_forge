# PROMPTS.md — AI Prompts Used in Skill Forge

This document covers two categories of AI prompt usage:
1. **Runtime prompts** — LLM prompts embedded in the application (`src/prompts.ts`)
2. **Test Prompts** — LLM prompts used shown in demo video to test the application

---

## 1. Runtime LLM Prompts

All prompts are defined in [`agents-starter/src/prompts.ts`](agents-starter/src/prompts.ts). The application uses two LLMs:
- **Anthropic Claude** (chat agent — streaming responses, tool calls, skill refinement/search)
- **Workers AI Llama 3.3 70B** (ingestion workflow — structured extraction, no external API dependency)

### SYSTEM_PROMPT

**Where**: Agent `onChatMessage` → `streamText({ system: SYSTEM_PROMPT })`
**LLM**: Anthropic Claude
**Purpose**: Defines the chat agent's persona ("Skill Forge, a developer skill architect") and behavior rules.

```
You are Skill Forge, a developer skill architect. Your job is to help developers
capture, structure, and manage reusable problem-solving patterns ("skills") from
their AI conversation history.

Behavior rules:
- Be direct and efficient. State what you found, then suggest the next step.
- Never restate the user's input back to them.
- Never use hedging language: no "perhaps", "maybe", "it might be worth considering".
- When presenting analysis, use structured formats (tables, bullets, code blocks).
- When chatting, use short paragraphs — max 3 sentences per paragraph.
- Always reference specific content from the user's provided data. Never give generic advice.
- If you lack sufficient information to complete a task, say exactly what's missing and ask for it.

You have access to the user's skill repository. When relevant, reference existing skills by name.

Response format: Always respond in plain text or markdown. Never wrap your response in ```json
or ```yaml unless explicitly producing a skill definition.
```

**Design rationale**: The "no hedging" and "no restating" rules prevent verbose AI responses. The "structured formats" rule ensures tool results are presented clearly. These constraints were iterated through testing — early versions without these rules produced wordy, unfocused responses.

---

### SYNTHESIZE_PROMPT

**Where**: Workflow Step 1 → `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast")`
**LLM**: Workers AI (Llama 3.3 70B)
**Purpose**: Extract ONE decision skill from selected conversation turns.

```
Analyze the following conversation turns and synthesize ONE decision skill.

A "decision skill" captures WHEN and WHY to choose a particular approach — not just
how to implement it. Focus on:
- DECISION FRAMEWORKS: When to use X vs Y, and the criteria for choosing
- TRADEOFFS: What you gain and lose with each approach
- TRIGGER PATTERNS: Situations that signal this skill is relevant
- ANTI-PATTERNS: Common mistakes the conversation reveals

You must return exactly ONE skill. If the conversation covers multiple topics,
identify the single most substantive decision-making pattern that ties them together.

Selected conversation turns:
---
{selected_turns}
---

{skill_hint_section}

Respond ONLY with a single JSON object (NOT an array). No preamble, no explanation.
{
  "name": "kebab-case-skill-name",
  "description": "One sentence: when this decision skill applies",
  "tags": ["tag1", "tag2", "tag3"],
  "trigger_patterns": [...],
  "key_decisions": [...]
}
```

**Design rationale**: The emphasis on "decision skills" (not implementation how-tos) produces more reusable, transferable knowledge. The "ONLY with a single JSON object" constraint prevents Llama from wrapping output in markdown code fences, which was a common failure mode during development.

---

### CROSSREF_PROMPT

**Where**: Workflow Step 2 → `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast")`
**LLM**: Workers AI (Llama 3.3 70B)
**Purpose**: Compare newly synthesized skill against existing repository. Returns `new`, `update`, or `duplicate` verdict.

```
You are comparing a newly synthesized skill against an existing skill repository.

EXISTING SKILLS in the repository:
---
{existing_skills_summary}
---

NEWLY SYNTHESIZED SKILL:
---
{new_skill_json}
---

Determine:
1. "new" — No existing skill covers this. Should create a new skill.
2. "update" — An existing skill partially covers this. The new skill adds information.
3. "duplicate" — An existing skill already fully covers this. Skip it.

Respond ONLY with a single JSON object (NOT an array):
{
  "pattern_name": "the-skill-name",
  "verdict": "new|update|duplicate",
  "target_skill": null or "existing-skill-name",
  "reason": "one sentence explaining the verdict",
  "new_information": null or "what this skill adds that the existing skill lacks"
}
```

**Design rationale**: This deduplication step prevents the skill repository from accumulating near-identical entries. The three-way verdict (new/update/duplicate) gives the system flexibility to merge related skills rather than only creating or skipping.

---

### DRAFT_PROMPT

**Where**: Workflow Step 3 → `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast")`
**LLM**: Workers AI (Llama 3.3 70B)
**Purpose**: Generate a complete SKILL.md with YAML frontmatter and structured sections.

```
Generate a complete skill definition following the exact schema below.

SCHEMA (you must follow this structure precisely):
---
name: {skill_name}
description: "{one_line_description}"
tags: [{tags}]
...
trigger_patterns:
  - "{pattern_1}"
  - "{pattern_2}"
---

# {Skill Title}

## Overview
[2-3 sentences: what this skill does and when to use it]

## When to Use
[Bullet list of 3-5 specific trigger scenarios — be concrete, not generic]

## Key Decisions
[For each decision point, explain the choice, tradeoffs, and recommendation]

## Process
[Numbered step-by-step decision-making process. Each step must be actionable.
Focus on how to DECIDE, not how to IMPLEMENT.]

## Anti-Patterns
[2-4 common mistakes this skill prevents. Format: "Do NOT [bad thing] — instead [good thing]"]

## Examples
[Concrete decision scenario → recommended choice → reasoning]

CONTEXT FOR THIS SKILL:
{synthesized_skill_json}
{key_decisions_section}
{selected_turns_text}
{existing_skill_section}
```

**Design rationale**: The explicit schema with section instructions prevents the LLM from improvising structure. The "Focus on how to DECIDE, not how to IMPLEMENT" instruction was critical — without it, Llama tends to produce implementation tutorials rather than reusable decision frameworks.

---

### REFINE_PROMPT

**Where**: Agent `refineSkill` tool → `streamText()`
**LLM**: Anthropic Claude
**Purpose**: Apply user feedback to modify an existing skill definition.

```
You are refining a skill definition based on user feedback.

Current skill definition:
---
{current_skill_markdown}
---

User's feedback:
"{user_feedback}"

Rules:
- Make ONLY the changes the user requested. Do not rewrite unrelated sections.
- If the feedback is ambiguous, make your best interpretation and note what you assumed.
- If the feedback contradicts the skill schema, keep the field but explain why.
- After making changes, output the COMPLETE updated skill definition (not a diff).
- Before the skill definition, write ONE sentence summarizing what you changed.
```

**Design rationale**: "Make ONLY the changes" prevents the LLM from rewriting the entire skill on each refinement. Outputting the complete definition (not a diff) simplifies the update logic — the agent replaces the stored skill wholesale.

---

### SEARCH_PROMPT

**Where**: Agent `searchSkills` tool → `streamText()`
**LLM**: Anthropic Claude
**Purpose**: Answer user queries using only skills in the repository.

```
The user is searching their skill repository. Answer their query using ONLY the
skills provided below. Do not invent or suggest skills that are not in the repository.

User's query: "{user_query}"

Matching skills from repository:
---
{matching_skills_summary}
---

If the query is a direct lookup, list matching skills with descriptions and metadata.
If the query is a problem-solving question, identify relevant skills and suggest loading the full skill.
If no skills match, say so directly and suggest ingesting conversations related to this topic.
```

**Design rationale**: The "ONLY the skills provided" constraint is critical — without it, the LLM hallucinates skills that don't exist in the repository. The three response modes (lookup, problem-solving, no match) cover the main search intent patterns.

---

## 2. Test Prompts

How should I structure project docs so AI stays aligned with the original plan throughout implementation?
What if I need to change a feature mid-implementation because the original design turned out infeasible?