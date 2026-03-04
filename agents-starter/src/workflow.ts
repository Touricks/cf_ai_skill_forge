import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import type { IngestionWorkflowParams } from "./types";
import {
  SYSTEM_PROMPT,
  SYNTHESIZE_PROMPT,
  CROSSREF_PROMPT,
  DRAFT_PROMPT,
  fillTemplate
} from "./prompts";
import {
  extractAiResponse,
  parseJsonResponse,
  validateSynthesizedSkill,
  validateSingleVerdict
} from "./workflow-helpers";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// Re-export helpers for backwards compatibility
export {
  extractAiResponse,
  parseJsonResponse,
  validateSynthesizedSkill,
  validateSingleVerdict
} from "./workflow-helpers";

// ── Workflow ────────────────────────────────────────────────

export class IngestionPipeline extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<IngestionWorkflowParams>, step: WorkflowStep) {
    const { selectedTurns, skillHint, existingSkills, existingSkillContent } =
      event.payload;

    const turnsText = selectedTurns.join("\n\n---\n\n");

    // Step 1: Synthesize ONE decision skill from selected turns
    const synthesizedSkill = await step.do(
      "synthesize-skill",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const hintSection = skillHint
          ? `The user wants to capture this specific skill: "${skillHint}"`
          : "";

        const prompt = fillTemplate(SYNTHESIZE_PROMPT, {
          selected_turns: turnsText,
          skill_hint_section: hintSection
        });

        const response = await this.env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt }
          ],
          max_tokens: 1000,
          temperature: 0.3
        });

        const raw = extractAiResponse(response);

        let parsed: unknown;
        try {
          parsed = parseJsonResponse<unknown>(raw);
        } catch {
          // Retry with stricter prompt
          const retryResponse = await this.env.AI.run(MODEL, {
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `${prompt}\n\nCRITICAL: Respond with ONLY a single JSON object. No text before or after. NOT an array.`
              }
            ],
            max_tokens: 1000,
            temperature: 0.2
          });
          const retryRaw = extractAiResponse(retryResponse);
          try {
            parsed = parseJsonResponse<unknown>(retryRaw);
          } catch {
            return null;
          }
        }

        return validateSynthesizedSkill(parsed);
      }
    );

    // Step 2: Crossref against existing skills
    const verdict = await step.do(
      "crossref-skill",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        if (!synthesizedSkill) return null;

        // If no existing skills, it's always new
        if (existingSkills.length === 0) {
          return {
            pattern_name: synthesizedSkill.name,
            verdict: "new" as const,
            target_skill: null,
            reason: "No existing skills in repository",
            new_information: null
          };
        }

        const skillsSummary = existingSkills
          .map(
            (s) =>
              `- ${s.name}: ${s.description} [tags: ${s.tags}] [triggers: ${s.trigger_patterns}]`
          )
          .join("\n");

        const prompt = fillTemplate(CROSSREF_PROMPT, {
          existing_skills_summary: skillsSummary,
          new_skill_json: JSON.stringify(synthesizedSkill, null, 2)
        });

        const response = await this.env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt }
          ],
          max_tokens: 500,
          temperature: 0.2
        });

        const raw = extractAiResponse(response);

        try {
          const parsed = parseJsonResponse<unknown>(raw);
          return (
            validateSingleVerdict(parsed) || {
              pattern_name: synthesizedSkill.name,
              verdict: "new" as const,
              target_skill: null,
              reason: "Crossref parse failed, defaulting to new",
              new_information: null
            }
          );
        } catch {
          return {
            pattern_name: synthesizedSkill.name,
            verdict: "new" as const,
            target_skill: null,
            reason: "Crossref failed, defaulting to new",
            new_information: null
          };
        }
      }
    );

    // Step 3: Draft skill markdown
    const draft = await step.do(
      "draft-skill",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        if (!synthesizedSkill || !verdict || verdict.verdict === "duplicate") {
          return null;
        }

        const now = new Date().toISOString();

        const existingSection =
          verdict.verdict === "update" &&
          verdict.target_skill &&
          existingSkillContent?.[verdict.target_skill]
            ? `Existing skill to update:\n---\n${existingSkillContent[verdict.target_skill]}\n---`
            : "";

        const keyDecisionsText = synthesizedSkill.key_decisions
          .map(
            (d, i) =>
              `${i + 1}. Decision: ${d.decision}\n   Tradeoffs: ${d.tradeoffs}\n   Recommendation: ${d.recommendation}`
          )
          .join("\n\n");

        const prompt = fillTemplate(DRAFT_PROMPT, {
          skill_name: synthesizedSkill.name,
          one_line_description: synthesizedSkill.description,
          tags: synthesizedSkill.tags.map((t) => `"${t}"`).join(", "),
          dependencies: "[]",
          iso_date: now,
          conversation_ids: `"${event.payload.agentId}"`,
          synthesized_skill_json: JSON.stringify(synthesizedSkill, null, 2),
          key_decisions_section: keyDecisionsText,
          selected_turns_text: turnsText,
          existing_skill_section: existingSection
        });

        const response = await this.env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt }
          ],
          max_tokens: 2000,
          temperature: 0.5
        });

        const raw = extractAiResponse(response);
        return raw.trim() || null;
      }
    );

    return {
      synthesizedSkill,
      verdict,
      draft,
      message: synthesizedSkill
        ? null
        : "Could not synthesize a decision skill from the selected turns. Try selecting turns with more decision-making content."
    };
  }
}
