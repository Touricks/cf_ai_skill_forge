import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import type { Connection } from "agents";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";
import {
  SYSTEM_PROMPT,
  REFINE_PROMPT,
  SEARCH_PROMPT,
  fillTemplate
} from "./prompts";
import { extractAiResponse } from "./workflow-helpers";
import { computeGraphData } from "./graph";
import type {
  IngestionClientMessage,
  IngestionAgentMessage,
  SkillMetadata,
  SkillForgeState,
  IngestionWorkflowResult
} from "./types";

const INITIAL_STATE: SkillForgeState = {
  skills: [],
  graphData: { nodes: [], edges: [] },
  draftSkill: null,
  synthesizedSkill: null,
  ingestionStatus: "idle"
};

// Type helper for state access
type SkillRow = Record<string, string | number | boolean | null>;

export class ChatAgent extends AIChatAgent<Env> {
  // ── Lifecycle ─────────────────────────────────────────
  onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      version TEXT NOT NULL DEFAULT '1.0.0',
      created TEXT NOT NULL,
      last_used TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      source_conversations TEXT NOT NULL DEFAULT '[]',
      trigger_patterns TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      ingested_at TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      extracted_patterns TEXT
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversation_skill_links (
      conversation_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      PRIMARY KEY (conversation_id, skill_name)
    )`;

    // Initialize state if empty
    const s = this.state as Partial<SkillForgeState>;
    if (!s || !s.skills) {
      this.setState(INITIAL_STATE);
    }
  }

  // ── Chat (managed by AIChatAgent framework) ──────────
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const anthropic = createAnthropic({
      apiKey: this.env.ANTHROPIC_API_KEY
    });

    const result = streamText({
      model: anthropic(this.env.MODEL),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        searchSkills: tool({
          description:
            "Search the user's skill repository by query. Use when the user asks about their skills or wants to find a skill.",
          inputSchema: z.object({
            query: z
              .string()
              .describe("Search query — keyword, topic, or question")
          }),
          execute: async ({ query }) => {
            const pattern = `%${query}%`;
            let rows = this
              .sql<SkillRow>`SELECT name, description, tags, trigger_patterns, usage_count
               FROM skills
               WHERE name LIKE ${pattern} OR description LIKE ${pattern}
                  OR tags LIKE ${pattern} OR trigger_patterns LIKE ${pattern}
               ORDER BY usage_count DESC LIMIT 10`;

            // Fallback: return top skills by usage for LLM to reason about
            if (rows.length === 0) {
              rows = this
                .sql<SkillRow>`SELECT name, description, tags, trigger_patterns, usage_count
                 FROM skills ORDER BY usage_count DESC LIMIT 20`;
            }

            if (rows.length === 0) {
              return {
                results: [],
                message:
                  "No skills in repository yet. Ingest some conversations to build your skill library."
              };
            }

            const candidates = rows.map((r) => ({
              name: r.name,
              description: r.description,
              tags: JSON.parse(r.tags as string),
              triggerPatterns: JSON.parse(r.trigger_patterns as string),
              usageCount: r.usage_count
            }));

            const answer = await this.callSearch(query, candidates);
            return { results: candidates, answer };
          }
        }),

        listSkills: tool({
          description:
            "List all skills in the user's repository with their metadata.",
          inputSchema: z.object({}),
          execute: async () => {
            const rows = this
              .sql<SkillRow>`SELECT name, description, tags, version, usage_count,
                      created, last_used, trigger_patterns
               FROM skills ORDER BY last_used DESC`;
            if (rows.length === 0) {
              return {
                skills: [],
                message:
                  "No skills in repository yet. Paste a conversation in the Ingestion Panel to get started."
              };
            }
            return {
              skills: rows.map((r) => ({
                name: r.name,
                description: r.description,
                tags: JSON.parse(r.tags as string),
                version: r.version,
                usageCount: r.usage_count,
                created: r.created,
                lastUsed: r.last_used,
                triggerPatterns: JSON.parse(r.trigger_patterns as string)
              })),
              count: rows.length
            };
          }
        }),

        viewSkill: tool({
          description:
            "View the full content of a specific skill by name. Use when the user asks to see, show, or open a skill.",
          inputSchema: z.object({
            skillName: z
              .string()
              .describe("The kebab-case name of the skill to view")
          }),
          execute: async ({ skillName }) => {
            const rows = this
              .sql<SkillRow>`SELECT content, usage_count FROM skills WHERE name = ${skillName}`;
            if (rows.length === 0) {
              return { error: `Skill "${skillName}" not found.` };
            }
            const now = new Date().toISOString();
            this
              .sql`UPDATE skills SET usage_count = usage_count + 1, last_used = ${now} WHERE name = ${skillName}`;
            return {
              content: rows[0].content,
              usageCount: (rows[0].usage_count as number) + 1,
              lastUsed: now
            };
          }
        }),

        refineSkill: tool({
          description:
            "Refine an existing skill based on user feedback. Use when the user wants to edit, improve, or change a skill definition.",
          inputSchema: z.object({
            skillName: z.string().describe("Name of the skill to refine"),
            feedback: z
              .string()
              .describe("User's specific feedback for what to change")
          }),
          execute: async ({ skillName, feedback }) => {
            const s = this.state as Partial<SkillForgeState>;
            let currentContent: string | null = null;

            // Check draft first (active draft being refined)
            if (s?.draftSkill) {
              currentContent = s.draftSkill;
            }

            // Fallback: load from SQLite (saved skill being re-refined)
            if (!currentContent) {
              const rows = this
                .sql<SkillRow>`SELECT content FROM skills WHERE name = ${skillName}`;
              if (rows.length > 0) {
                currentContent = rows[0].content as string;
              }
            }

            if (!currentContent) {
              return {
                error: `Skill "${skillName}" not found in drafts or repository.`
              };
            }

            // Call LLM with REFINE_PROMPT
            const refined = await this.callRefine(currentContent, feedback);

            // Update state.draftSkill with the refined version
            this.setState({
              ...s,
              draftSkill: refined
            } as SkillForgeState);

            return {
              refinedSkill: refined,
              instruction:
                "Present the one-sentence change summary from the refined output. Tell the user they can provide more feedback to keep refining, or approve the skill when satisfied."
            };
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Ingestion channel (custom WebSocket messages) ────
  async onMessage(connection: Connection, message: string): Promise<void> {
    let parsed: IngestionClientMessage;
    try {
      parsed = JSON.parse(message) as IngestionClientMessage;
    } catch {
      this.sendIngestion(connection, {
        type: "error",
        message: "Invalid JSON"
      });
      return;
    }

    switch (parsed.type) {
      case "ingest":
        return this.handleIngest(connection, parsed.turns, parsed.skillHint);
      case "approve":
        return this.handleApprove(connection, parsed.skillName);
      case "delete_skill":
        return this.handleDeleteSkill(connection, parsed.skillName);
      default:
        // Unknown message type — ignore (may be framework message)
        break;
    }
  }

  // ── Ingestion handlers ─────────────────────────────────
  private async handleIngest(
    connection: Connection,
    turns: string[],
    skillHint?: string
  ): Promise<void> {
    try {
      const combined = turns.join("\n");
      if (combined.trim().length < 50) {
        this.sendIngestion(connection, {
          type: "error",
          message:
            "Selected turns are too short (min 50 characters). Select more turns."
        });
        return;
      }

      // Store conversation
      const conversationId = crypto.randomUUID();
      const now = new Date().toISOString();
      this.sql`INSERT INTO conversations (id, title, ingested_at, raw_text)
        VALUES (${conversationId}, ${"Imported conversation"}, ${now}, ${combined})`;

      // Load existing skills for crossref
      const existingRows = this
        .sql<SkillRow>`SELECT name, description, tags, trigger_patterns, content FROM skills`;
      const existingSkills = existingRows.map((r) => ({
        name: r.name as string,
        description: r.description as string,
        tags: r.tags as string,
        trigger_patterns: r.trigger_patterns as string
      }));
      const existingSkillContent: Record<string, string> = {};
      for (const r of existingRows) {
        existingSkillContent[r.name as string] = r.content as string;
      }

      // Trigger workflow
      const instance = await this.env.INGESTION_WORKFLOW.create({
        params: {
          selectedTurns: turns,
          skillHint,
          agentId: conversationId,
          existingSkills,
          existingSkillContent
        }
      });

      this.sendIngestion(connection, {
        type: "ingestion_started",
        workflowId: instance.id
      });

      const s = this.state as Partial<SkillForgeState>;
      this.setState({ ...s, ingestionStatus: "running" } as SkillForgeState);

      // Fire-and-forget polling
      this.pollWorkflow(connection, instance, conversationId);
    } catch (err) {
      this.sendIngestion(connection, {
        type: "error",
        message: `Ingestion failed: ${err instanceof Error ? err.message : "unknown error"}`
      });
      const s = this.state as Partial<SkillForgeState>;
      this.setState({ ...s, ingestionStatus: "error" } as SkillForgeState);
    }
  }

  private async pollWorkflow(
    connection: Connection,
    instance: {
      id: string;
      status: () => Promise<{
        status: string;
        output?: unknown;
        error?: { message: string };
      }>;
    },
    conversationId: string
  ): Promise<void> {
    const POLL_INTERVAL = 5000;
    const MAX_POLLS = 60;
    const STEPS = ["synthesizing", "cross-referencing", "drafting skill"];

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

      let result: {
        status: string;
        output?: unknown;
        error?: { message: string };
      };
      try {
        result = await instance.status();
      } catch {
        continue; // Transient error, keep polling
      }

      // Send progress
      const stepIdx = Math.min(Math.floor(i / 4), STEPS.length - 1);
      const pct = Math.min(Math.round(((i + 1) / 20) * 100), 95);
      this.sendIngestion(connection, {
        type: "ingestion_progress",
        step: STEPS[stepIdx],
        progress: pct
      });

      if (result.status === "complete") {
        this.sendIngestion(connection, {
          type: "ingestion_progress",
          step: "complete",
          progress: 100
        });
        this.handleWorkflowComplete(connection, result.output, conversationId);
        return;
      }

      if (result.status === "errored") {
        this.sendIngestion(connection, {
          type: "error",
          message: `Ingestion pipeline failed: ${result.error?.message || "unknown error"}`
        });
        const s = this.state as Partial<SkillForgeState>;
        this.setState({
          ...s,
          ingestionStatus: "error"
        } as SkillForgeState);
        return;
      }
    }

    // Timeout
    this.sendIngestion(connection, {
      type: "error",
      message: "Ingestion timed out after 5 minutes."
    });
    const s = this.state as Partial<SkillForgeState>;
    this.setState({ ...s, ingestionStatus: "error" } as SkillForgeState);
  }

  private handleWorkflowComplete(
    connection: Connection,
    output: unknown,
    conversationId: string
  ): void {
    const result = output as IngestionWorkflowResult;

    if (!result.synthesizedSkill) {
      this.sendIngestion(connection, {
        type: "error",
        message:
          result.message ||
          "Could not synthesize a skill. Try selecting turns with more decision-making content."
      });
      const s = this.state as Partial<SkillForgeState>;
      this.setState({
        ...s,
        ingestionStatus: "complete"
      } as SkillForgeState);
      return;
    }

    // Store synthesized skill reference
    this
      .sql`UPDATE conversations SET extracted_patterns = ${JSON.stringify(result.synthesizedSkill)} WHERE id = ${conversationId}`;

    // Send synthesized skill + draft to client
    this.sendIngestion(connection, {
      type: "skill_synthesized",
      skill: result.synthesizedSkill,
      markdown: result.draft || ""
    });

    // Update state
    const s = this.state as Partial<SkillForgeState>;
    this.setState({
      ...s,
      synthesizedSkill: result.synthesizedSkill,
      draftSkill: result.draft || null,
      ingestionStatus: "complete"
    } as SkillForgeState);
  }

  private handleApprove(connection: Connection, skillName: string): void {
    const s = this.state as Partial<SkillForgeState>;
    const draft = s?.draftSkill;
    if (!draft) {
      this.sendIngestion(connection, {
        type: "error",
        message: "No draft skill to approve."
      });
      return;
    }

    try {
      const now = new Date().toISOString();
      const synth = s?.synthesizedSkill;
      const description =
        synth?.description || "Skill extracted from conversation";
      const tags = JSON.stringify(synth?.tags || []);
      const triggerPatterns = JSON.stringify(synth?.trigger_patterns || []);

      // Upsert skill
      this.sql`INSERT OR REPLACE INTO skills
        (name, description, tags, dependencies, version, created, last_used,
         usage_count, source_conversations, trigger_patterns, content)
        VALUES (${skillName}, ${description}, ${tags}, ${"[]"}, ${"1.0.0"},
                ${now}, ${now}, ${0}, ${"[]"}, ${triggerPatterns}, ${draft})`;

      // Link conversation
      const convRows = this
        .sql<SkillRow>`SELECT id FROM conversations ORDER BY ingested_at DESC LIMIT 1`;
      if (convRows.length > 0) {
        const convId = convRows[0].id as string;
        this
          .sql`INSERT OR IGNORE INTO conversation_skill_links (conversation_id, skill_name)
          VALUES (${convId}, ${skillName})`;
      }

      // Refresh state
      const skills = this.loadSkillMetadata();
      const graphData = computeGraphData(skills);
      this.setState({
        skills,
        graphData,
        draftSkill: null,
        synthesizedSkill: null,
        ingestionStatus: "idle"
      } as SkillForgeState);

      this.sendIngestion(connection, {
        type: "skill_saved",
        name: skillName
      });
    } catch (err) {
      this.sendIngestion(connection, {
        type: "error",
        message: `Failed to save skill: ${err instanceof Error ? err.message : "unknown error"}`
      });
    }
  }

  private handleDeleteSkill(connection: Connection, skillName: string): void {
    const existing = this
      .sql<SkillRow>`SELECT name FROM skills WHERE name = ${skillName}`;
    if (existing.length === 0) {
      this.sendIngestion(connection, {
        type: "error",
        message: `Skill "${skillName}" not found.`
      });
      return;
    }

    try {
      this.sql`DELETE FROM skills WHERE name = ${skillName}`;
      this
        .sql`DELETE FROM conversation_skill_links WHERE skill_name = ${skillName}`;

      const skills = this.loadSkillMetadata();
      const graphData = computeGraphData(skills);
      this.setState({
        skills,
        graphData,
        draftSkill: null,
        synthesizedSkill: null,
        ingestionStatus: "idle"
      } as SkillForgeState);

      this.sendIngestion(connection, {
        type: "skill_deleted",
        name: skillName
      });
    } catch (err) {
      this.sendIngestion(connection, {
        type: "error",
        message: `Failed to delete skill: ${err instanceof Error ? err.message : "unknown error"}`
      });
    }
  }

  // ── LLM helpers (inner calls from tools) ────────────────
  private async callRefine(
    currentMarkdown: string,
    feedback: string
  ): Promise<string> {
    try {
      const prompt = fillTemplate(REFINE_PROMPT, {
        current_skill_markdown: currentMarkdown,
        user_feedback: feedback
      });
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const,
        {
          messages: [
            {
              role: "system",
              content: "You are Skill Forge, a developer skill architect."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 2000,
          temperature: 0.3
        }
      );
      return extractAiResponse(response);
    } catch (err) {
      return `Error refining skill: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  private async callSearch(
    query: string,
    candidates: unknown[]
  ): Promise<string> {
    try {
      const prompt = fillTemplate(SEARCH_PROMPT, {
        user_query: query,
        matching_skills_summary: JSON.stringify(candidates, null, 2)
      });
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const,
        {
          messages: [
            {
              role: "system",
              content: "You are Skill Forge, a developer skill architect."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 500,
          temperature: 0.4
        }
      );
      return extractAiResponse(response);
    } catch (err) {
      return `Error searching skills: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  // ── Helpers ─────────────────────────────────────────────
  private sendIngestion(
    connection: Connection,
    message: IngestionAgentMessage
  ): void {
    connection.send(JSON.stringify(message));
  }

  loadSkillMetadata(): SkillMetadata[] {
    const rows = this
      .sql<SkillRow>`SELECT name, description, tags, dependencies, version,
      created, last_used, usage_count,
      source_conversations, trigger_patterns
      FROM skills`;

    return rows.map((r) => ({
      name: r.name as string,
      description: r.description as string,
      tags: JSON.parse(r.tags as string),
      dependencies: JSON.parse(r.dependencies as string),
      version: r.version as string,
      created: r.created as string,
      last_used: r.last_used as string,
      usage_count: r.usage_count as number,
      source_conversations: JSON.parse(r.source_conversations as string),
      trigger_patterns: JSON.parse(r.trigger_patterns as string)
    }));
  }
}

// Workflow export
export { IngestionPipeline } from "./workflow";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
