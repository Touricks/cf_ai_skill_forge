import { describe, it, expect } from "vitest";
import {
  fillTemplate,
  SYSTEM_PROMPT,
  SYNTHESIZE_PROMPT,
  CROSSREF_PROMPT,
  DRAFT_PROMPT,
  REFINE_PROMPT,
  SEARCH_PROMPT
} from "../src/prompts";

// ── fillTemplate ─────────────────────────────────────────────

describe("fillTemplate", () => {
  it("replaces single placeholder", () => {
    expect(fillTemplate("Hello {name}", { name: "Alice" })).toBe("Hello Alice");
  });

  it("replaces multiple different placeholders", () => {
    expect(
      fillTemplate("{greeting} {name}, you have {count} skills", {
        greeting: "Hi",
        name: "Bob",
        count: "5"
      })
    ).toBe("Hi Bob, you have 5 skills");
  });

  it("replaces multiple occurrences of same placeholder", () => {
    expect(fillTemplate("{x} and {x}", { x: "ok" })).toBe("ok and ok");
  });

  it("leaves unreplaced placeholders as-is", () => {
    expect(fillTemplate("Hello {name}", {})).toBe("Hello {name}");
  });

  it("returns template unchanged when no placeholders", () => {
    expect(fillTemplate("no placeholders", { x: "y" })).toBe("no placeholders");
  });

  it("returns empty string for empty template", () => {
    expect(fillTemplate("", { x: "y" })).toBe("");
  });

  it("handles underscored placeholder names", () => {
    expect(
      fillTemplate("{skill_name} is good", { skill_name: "react-patterns" })
    ).toBe("react-patterns is good");
  });
});

// ── Prompt constants ─────────────────────────────────────────

describe("prompt constants", () => {
  const prompts = {
    SYSTEM_PROMPT,
    SYNTHESIZE_PROMPT,
    CROSSREF_PROMPT,
    DRAFT_PROMPT,
    REFINE_PROMPT,
    SEARCH_PROMPT
  };

  for (const [name, value] of Object.entries(prompts)) {
    it(`${name} is a non-empty string`, () => {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(50);
    });
  }
});
