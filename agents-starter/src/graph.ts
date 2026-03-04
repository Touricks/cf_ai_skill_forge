import type { SkillMetadata, GraphNode, GraphEdge } from "./types";

export const TAG_COLORS: Record<string, string> = {
  architecture: "#f97316",
  frontend: "#3b82f6",
  backend: "#10b981",
  devops: "#8b5cf6",
  testing: "#ec4899",
  documentation: "#eab308",
  default: "#6b7280"
};

export function computeGraphData(skills: SkillMetadata[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  if (!skills.length) return { nodes: [], edges: [] };

  const nodes: GraphNode[] = skills.map((s) => ({
    id: s.name,
    tags: s.tags,
    size: Math.max(12, Math.log(s.usage_count + 1) * 12),
    color: TAG_COLORS[s.tags[0]?.toLowerCase()] || TAG_COLORS.default
  }));

  const edges: GraphEdge[] = [];

  for (const skill of skills) {
    for (const dep of skill.dependencies) {
      if (skills.some((s) => s.name === dep)) {
        edges.push({
          source: skill.name,
          target: dep,
          type: "dependency"
        });
      }
    }
  }

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const shared = skills[i].source_conversations.filter((id) =>
        skills[j].source_conversations.includes(id)
      );
      if (shared.length > 0) {
        edges.push({
          source: skills[i].name,
          target: skills[j].name,
          type: "shared_conversation",
          weight: shared.length
        });
      }
    }
  }

  return { nodes, edges };
}
