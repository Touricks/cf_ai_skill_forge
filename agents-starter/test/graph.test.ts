import { describe, it, expect } from "vitest";
import { computeGraphData } from "../src/graph";
import type { SkillMetadata } from "../src/types";

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    description: "A test skill",
    tags: [],
    dependencies: [],
    version: "1.0.0",
    created: "2026-01-01T00:00:00Z",
    last_used: "2026-01-01T00:00:00Z",
    usage_count: 0,
    source_conversations: [],
    trigger_patterns: [],
    ...overrides
  };
}

describe("computeGraphData", () => {
  it("returns empty nodes and edges for empty skills", () => {
    const result = computeGraphData([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("creates one node for single skill", () => {
    const result = computeGraphData([makeSkill({ name: "skill-a" })]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("skill-a");
    expect(result.edges).toHaveLength(0);
  });

  it("creates dependency edge between skills", () => {
    const result = computeGraphData([
      makeSkill({ name: "child", dependencies: ["parent"] }),
      makeSkill({ name: "parent" })
    ]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: "child",
      target: "parent",
      type: "dependency"
    });
  });

  it("does not create edge for non-existent dependency", () => {
    const result = computeGraphData([
      makeSkill({ name: "orphan", dependencies: ["missing-skill"] })
    ]);
    expect(result.edges).toHaveLength(0);
  });

  it("creates shared_conversation edge with weight", () => {
    const result = computeGraphData([
      makeSkill({ name: "a", source_conversations: ["conv1", "conv2"] }),
      makeSkill({ name: "b", source_conversations: ["conv2", "conv3"] })
    ]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: "a",
      target: "b",
      type: "shared_conversation",
      weight: 1
    });
  });

  it("weights shared_conversation by number of shared conversations", () => {
    const result = computeGraphData([
      makeSkill({
        name: "a",
        source_conversations: ["c1", "c2", "c3"]
      }),
      makeSkill({
        name: "b",
        source_conversations: ["c1", "c2", "c3"]
      })
    ]);
    expect(result.edges[0].weight).toBe(3);
  });

  it("does not create edge when no shared conversations", () => {
    const result = computeGraphData([
      makeSkill({ name: "a", source_conversations: ["c1"] }),
      makeSkill({ name: "b", source_conversations: ["c2"] })
    ]);
    expect(result.edges).toHaveLength(0);
  });

  it("scales node size with usage_count (logarithmic)", () => {
    const result = computeGraphData([
      makeSkill({ name: "unused", usage_count: 0 }),
      makeSkill({ name: "used", usage_count: 100 })
    ]);
    const unused = result.nodes.find((n) => n.id === "unused")!;
    const used = result.nodes.find((n) => n.id === "used")!;
    expect(unused.size).toBe(12); // Math.max(12, Math.log(1) * 12) = 12
    expect(used.size).toBeGreaterThan(unused.size);
  });

  it("assigns color by first tag", () => {
    const result = computeGraphData([
      makeSkill({ name: "fe", tags: ["frontend", "react"] }),
      makeSkill({ name: "be", tags: ["backend"] })
    ]);
    const fe = result.nodes.find((n) => n.id === "fe")!;
    const be = result.nodes.find((n) => n.id === "be")!;
    expect(fe.color).toBe("#3b82f6"); // frontend blue
    expect(be.color).toBe("#10b981"); // backend green
  });

  it("uses default color for unknown tags", () => {
    const result = computeGraphData([
      makeSkill({ name: "x", tags: ["obscure-tag"] })
    ]);
    expect(result.nodes[0].color).toBe("#6b7280"); // default gray
  });

  it("uses default color for empty tags", () => {
    const result = computeGraphData([makeSkill({ name: "x", tags: [] })]);
    expect(result.nodes[0].color).toBe("#6b7280");
  });
});
