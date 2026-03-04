// ============================================================
// Domain models
// ============================================================
export interface ExtractedPattern {
  name: string;
  description: string;
  evidence: string[];
  completeness: "complete" | "partial" | "fragment";
  tags: string[];
}

export interface ConversationTurn {
  index: number;
  speaker: string;
  text: string;
  estimatedTokens: number;
}

export interface SynthesizedSkill {
  name: string;
  description: string;
  tags: string[];
  trigger_patterns: string[];
  key_decisions: Array<{
    decision: string;
    tradeoffs: string;
    recommendation: string;
  }>;
}

export interface CrossrefVerdict {
  pattern_name: string;
  verdict: "new" | "update" | "duplicate";
  target_skill: string | null;
  reason: string;
  new_information: string | null;
}

export interface SkillMetadata {
  name: string;
  description: string;
  tags: string[];
  dependencies: string[];
  version: string;
  created: string;
  last_used: string;
  usage_count: number;
  source_conversations: string[];
  trigger_patterns: string[];
}

export interface GraphNode {
  id: string;
  tags: string[];
  size: number;
  color: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "dependency" | "shared_conversation";
  weight?: number;
}

// ============================================================
// Ingestion channel messages (custom WebSocket protocol)
// Chat messages are handled by useAgentChat/onChatMessage — not here
// ============================================================

// Client → Agent (via useAgent.send)
export type IngestionClientMessage =
  | { type: "ingest"; turns: string[]; skillHint?: string }
  | { type: "approve"; skillName: string }
  | { type: "delete_skill"; skillName: string };

// Agent → Client (via connection.send / this.broadcast)
export type IngestionAgentMessage =
  | { type: "ingestion_started"; workflowId: string }
  | { type: "ingestion_progress"; step: string; progress: number }
  | { type: "skill_synthesized"; skill: SynthesizedSkill; markdown: string }
  | { type: "skill_saved"; name: string }
  | { type: "skill_deleted"; name: string }
  | { type: "error"; message: string };

// ============================================================
// Agent state (synced to frontend via useAgent setState)
// Note: chat state (messages, streaming) is managed by
// useAgentChat internally — not in this state object
// ============================================================
export interface SkillForgeState {
  skills: SkillMetadata[];
  graphData: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  draftSkill: string | null;
  synthesizedSkill: SynthesizedSkill | null;
  ingestionStatus: "idle" | "running" | "complete" | "error";
}

// ============================================================
// Workflow payload types
// ============================================================
export interface IngestionWorkflowParams {
  selectedTurns: string[];
  skillHint?: string;
  agentId: string;
  existingSkills: Array<{
    name: string;
    description: string;
    tags: string;
    trigger_patterns: string;
  }>;
  existingSkillContent: Record<string, string>;
}

export interface IngestionWorkflowResult {
  synthesizedSkill: SynthesizedSkill | null;
  verdict: CrossrefVerdict | null;
  draft: string | null;
  message: string | null;
}
