// ============================================================
// Prompt templates for Skill Forge LLM calls
//
// Where each prompt runs:
//   SYSTEM_PROMPT      → Agent onChatMessage (streamText system param)
//   SYNTHESIZE_PROMPT  → Workflow Step 1 (env.AI.run)
//   CROSSREF_PROMPT    → Workflow Step 2 (env.AI.run)
//   DRAFT_PROMPT       → Workflow Step 3 (env.AI.run)
//   REFINE_PROMPT      → Agent refineSkill tool (streamText)
//   SEARCH_PROMPT      → Agent searchSkills tool (streamText)
// ============================================================

export const SYSTEM_PROMPT = `You are Skill Forge, a developer skill architect. Your job is to help developers
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

Response format: Always respond in plain text or markdown. Never wrap your response in \`\`\`json
or \`\`\`yaml unless explicitly producing a skill definition.`;

export const SYNTHESIZE_PROMPT = `Analyze the following conversation turns and synthesize ONE decision skill.

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
  "trigger_patterns": [
    "situation or question that signals this skill is needed",
    "another trigger scenario"
  ],
  "key_decisions": [
    {
      "decision": "The choice or question being resolved",
      "tradeoffs": "What each option gains and loses",
      "recommendation": "The recommended approach and why"
    }
  ]
}`;

export const CROSSREF_PROMPT = `You are comparing a newly synthesized skill against an existing skill repository.

EXISTING SKILLS in the repository:
---
{existing_skills_summary}
---

Format of each existing skill above:
- name: the skill identifier
- description: what it does
- tags: categories
- trigger_patterns: when it activates

NEWLY SYNTHESIZED SKILL:
---
{new_skill_json}
---

Determine:
1. "new" — No existing skill covers this. Should create a new skill.
2. "update" — An existing skill partially covers this. The new skill adds information.
   Specify which existing skill to update and what new information to add.
3. "duplicate" — An existing skill already fully covers this. Skip it.

Respond ONLY with a single JSON object (NOT an array):
{
  "pattern_name": "the-skill-name",
  "verdict": "new|update|duplicate",
  "target_skill": null or "existing-skill-name",
  "reason": "one sentence explaining the verdict",
  "new_information": null or "what this skill adds that the existing skill lacks"
}`;

export const DRAFT_PROMPT = `Generate a complete skill definition following the exact schema below.

SCHEMA (you must follow this structure precisely):
---
name: {skill_name}
description: "{one_line_description}"
tags: [{tags}]
dependencies: [{dependencies}]
version: "1.0.0"
created: "{iso_date}"
last_used: "{iso_date}"
usage_count: 0
source_conversations: [{conversation_ids}]
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
[For each decision point from the conversation, explain:
- The choice or question being resolved
- The tradeoffs of each option
- The recommended approach and why
Format each as a subsection.]

## Process
[Numbered step-by-step decision-making process. Each step must be actionable.
Focus on how to DECIDE, not how to IMPLEMENT.
Do NOT write vague steps like "analyze the situation".
DO write specific steps like "Classify the error type: render error → Boundary, async → typed class, real-time → reconnection hook".]

## Anti-Patterns
[2-4 common mistakes this skill prevents. Format: "Do NOT [bad thing] — instead [good thing]"]

## Examples
[At least one concrete example showing a decision scenario → recommended choice → reasoning]

CONTEXT FOR THIS SKILL:

Synthesized skill data:
{synthesized_skill_json}

Key decisions identified:
{key_decisions_section}

Source conversation turns:
{selected_turns_text}

{existing_skill_section}

Generate the complete skill definition now. Output ONLY the skill markdown, starting with the --- frontmatter delimiter.`;

export const REFINE_PROMPT = `You are refining a skill definition based on user feedback.

Current skill definition:
---
{current_skill_markdown}
---

User's feedback:
"{user_feedback}"

Rules:
- Make ONLY the changes the user requested. Do not rewrite unrelated sections.
- If the feedback is ambiguous, make your best interpretation and note what you assumed.
- If the feedback contradicts the skill schema (e.g., removing a required field), keep the field but explain why in your response.
- After making changes, output the COMPLETE updated skill definition (not a diff).
- Before the skill definition, write ONE sentence summarizing what you changed.

Output format:
[one sentence summary of changes]

[complete updated skill markdown starting with --- frontmatter]`;

export const SEARCH_PROMPT = `The user is searching their skill repository. Answer their query using ONLY the
skills provided below. Do not invent or suggest skills that are not in the repository.

User's query: "{user_query}"

Matching skills from repository:
---
{matching_skills_summary}
---

If the query is a direct lookup (e.g., "show me my React skills"), list the matching
skills with their descriptions and key metadata.

If the query is a problem-solving question (e.g., "how should I handle API errors?"),
identify which skill(s) are relevant, briefly explain why, and suggest the user
load the full skill for details.

If no skills match, say so directly and suggest the user ingest conversations
related to this topic to build a skill.`;

/**
 * Replace template placeholders like {variable_name} with values.
 * Unreplaced placeholders are left as-is.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}
