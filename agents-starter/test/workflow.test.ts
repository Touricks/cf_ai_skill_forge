import { describe, it, expect } from "vitest";
import {
  extractAiResponse,
  parseJsonResponse,
  validateSynthesizedSkill,
  validateSingleVerdict
} from "../src/workflow-helpers";

// ── extractAiResponse ────────────────────────────────────────

describe("extractAiResponse", () => {
  it("returns string input as-is", () => {
    expect(extractAiResponse("hello")).toBe("hello");
  });

  it("extracts string from { response: string }", () => {
    expect(extractAiResponse({ response: "text" })).toBe("text");
  });

  it("JSON-stringifies array response", () => {
    expect(extractAiResponse({ response: [1, 2, 3] })).toBe("[1,2,3]");
  });

  it("JSON-stringifies object response", () => {
    expect(extractAiResponse({ response: { key: "val" } })).toBe(
      '{"key":"val"}'
    );
  });

  it('returns "" for null', () => {
    expect(extractAiResponse(null)).toBe("");
  });

  it('returns "" for undefined', () => {
    expect(extractAiResponse(undefined)).toBe("");
  });

  it('returns "" for empty object', () => {
    expect(extractAiResponse({})).toBe("");
  });

  it('returns "" for { response: null }', () => {
    expect(extractAiResponse({ response: null })).toBe("");
  });
});

// ── parseJsonResponse ────────────────────────────────────────

describe("parseJsonResponse", () => {
  it("parses valid JSON object", () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses valid JSON array", () => {
    expect(parseJsonResponse("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("extracts JSON from markdown code fence", () => {
    const input = '```json\n{"name":"test"}\n```';
    expect(parseJsonResponse(input)).toEqual({ name: "test" });
  });

  it("extracts JSON from fence without language tag", () => {
    const input = '```\n{"name":"test"}\n```';
    expect(parseJsonResponse(input)).toEqual({ name: "test" });
  });

  it("extracts JSON from text with leading prose", () => {
    const input = 'Here is the result: {"name":"test"} hope that helps';
    expect(parseJsonResponse(input)).toEqual({ name: "test" });
  });

  it("extracts array from text with leading prose", () => {
    const input = "The patterns are: [1, 2, 3] as requested";
    expect(parseJsonResponse(input)).toEqual([1, 2, 3]);
  });

  it("extracts outermost brackets", () => {
    const input = 'text {"outer": {"inner": 1}} more';
    expect(parseJsonResponse(input)).toEqual({ outer: { inner: 1 } });
  });

  it("throws on completely invalid input", () => {
    expect(() => parseJsonResponse("not json at all")).toThrow(
      "Failed to parse JSON"
    );
  });

  it("throws on empty string", () => {
    expect(() => parseJsonResponse("")).toThrow("Failed to parse JSON");
  });
});

// ── validateSynthesizedSkill ─────────────────────────────────

describe("validateSynthesizedSkill", () => {
  const validSkill = {
    name: "error-handling",
    description: "When to use try-catch vs error boundaries",
    tags: ["react", "errors"],
    trigger_patterns: ["error handling question"],
    key_decisions: [
      {
        decision: "try-catch vs boundary",
        tradeoffs: "granularity vs simplicity",
        recommendation: "use both"
      }
    ]
  };

  it("returns valid SynthesizedSkill", () => {
    const result = validateSynthesizedSkill(validSkill);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("error-handling");
    expect(result!.tags).toEqual(["react", "errors"]);
    expect(result!.key_decisions).toHaveLength(1);
  });

  it("extracts first element when wrapped in array", () => {
    const result = validateSynthesizedSkill([validSkill]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("error-handling");
  });

  it("returns null for empty array", () => {
    expect(validateSynthesizedSkill([])).toBeNull();
  });

  it("returns null for null input", () => {
    expect(validateSynthesizedSkill(null)).toBeNull();
  });

  it("returns null for missing name", () => {
    expect(validateSynthesizedSkill({ description: "test" })).toBeNull();
  });

  it("returns null for empty string name", () => {
    expect(
      validateSynthesizedSkill({ name: "  ", description: "test" })
    ).toBeNull();
  });

  it("returns null for missing description", () => {
    expect(validateSynthesizedSkill({ name: "test" })).toBeNull();
  });

  it("returns empty tags when tags is not array", () => {
    const result = validateSynthesizedSkill({
      name: "test",
      description: "desc",
      tags: "not-array"
    });
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual([]);
  });

  it("returns empty trigger_patterns when not array", () => {
    const result = validateSynthesizedSkill({
      name: "test",
      description: "desc"
    });
    expect(result).not.toBeNull();
    expect(result!.trigger_patterns).toEqual([]);
  });

  it("filters invalid key_decisions entries", () => {
    const result = validateSynthesizedSkill({
      name: "test",
      description: "desc",
      key_decisions: [
        { decision: "valid", tradeoffs: "t", recommendation: "r" },
        "invalid",
        null,
        { decision: "", tradeoffs: "t", recommendation: "r" }
      ]
    });
    expect(result).not.toBeNull();
    expect(result!.key_decisions).toHaveLength(1);
    expect(result!.key_decisions[0].decision).toBe("valid");
  });

  it("trims name and description", () => {
    const result = validateSynthesizedSkill({
      name: "  test  ",
      description: "  desc  "
    });
    expect(result!.name).toBe("test");
    expect(result!.description).toBe("desc");
  });
});

// ── validateSingleVerdict ────────────────────────────────────

describe("validateSingleVerdict", () => {
  const validVerdict = {
    pattern_name: "error-handling",
    verdict: "new",
    target_skill: null,
    reason: "No existing skill covers this",
    new_information: null
  };

  it("returns valid CrossrefVerdict", () => {
    const result = validateSingleVerdict(validVerdict);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("new");
    expect(result!.pattern_name).toBe("error-handling");
  });

  it("extracts first element when wrapped in array", () => {
    const result = validateSingleVerdict([validVerdict]);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("new");
  });

  it("returns null for empty array", () => {
    expect(validateSingleVerdict([])).toBeNull();
  });

  it("returns null for null input", () => {
    expect(validateSingleVerdict(null)).toBeNull();
  });

  it("returns null for invalid verdict value", () => {
    expect(
      validateSingleVerdict({
        pattern_name: "x",
        verdict: "maybe",
        reason: "r"
      })
    ).toBeNull();
  });

  it("returns null for missing pattern_name", () => {
    expect(validateSingleVerdict({ verdict: "new", reason: "r" })).toBeNull();
  });

  it("returns null for missing reason", () => {
    expect(
      validateSingleVerdict({ pattern_name: "x", verdict: "new" })
    ).toBeNull();
  });

  it("accepts all valid verdict values", () => {
    for (const v of ["new", "update", "duplicate"]) {
      const result = validateSingleVerdict({
        pattern_name: "x",
        verdict: v,
        reason: "r"
      });
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe(v);
    }
  });

  it("preserves target_skill as string", () => {
    const result = validateSingleVerdict({
      ...validVerdict,
      verdict: "update",
      target_skill: "existing-skill"
    });
    expect(result!.target_skill).toBe("existing-skill");
  });

  it("preserves new_information as string", () => {
    const result = validateSingleVerdict({
      ...validVerdict,
      new_information: "adds context about X"
    });
    expect(result!.new_information).toBe("adds context about X");
  });

  it("sets target_skill to null when non-string", () => {
    const result = validateSingleVerdict({
      ...validVerdict,
      target_skill: 123
    });
    expect(result!.target_skill).toBeNull();
  });
});
