import type { SynthesizedSkill, CrossrefVerdict } from "./types";

export function extractAiResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object" && "response" in response) {
    const r = (response as Record<string, unknown>).response;
    if (typeof r === "string") return r;
    // Workers AI may return already-parsed JSON (array/object)
    if (r != null) return JSON.stringify(r);
  }
  return "";
}

export function parseJsonResponse<T>(raw: string): T {
  // Layer 1: direct parse
  try {
    return JSON.parse(raw) as T;
  } catch {
    // continue
  }

  // Layer 2: strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  // Layer 3: find outermost brackets
  const firstBracket = raw.search(/[[{]/);
  if (firstBracket >= 0) {
    const opener = raw[firstBracket];
    const closer = opener === "[" ? "]" : "}";
    const lastBracket = raw.lastIndexOf(closer);
    if (lastBracket > firstBracket) {
      try {
        return JSON.parse(raw.slice(firstBracket, lastBracket + 1)) as T;
      } catch {
        // continue
      }
    }
  }

  throw new Error(
    `Failed to parse JSON from LLM response: ${raw.slice(0, 200)}`
  );
}

export function validateSynthesizedSkill(
  data: unknown
): SynthesizedSkill | null {
  // Handle case where LLM wraps result in an array
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    data = data[0];
  }

  if (!data || typeof data !== "object") return null;
  const s = data as Record<string, unknown>;

  if (
    typeof s.name !== "string" ||
    !s.name.trim() ||
    typeof s.description !== "string" ||
    !s.description.trim()
  )
    return null;

  const tags = Array.isArray(s.tags)
    ? (s.tags.filter((t: unknown) => typeof t === "string") as string[])
    : [];

  const triggerPatterns = Array.isArray(s.trigger_patterns)
    ? (s.trigger_patterns.filter(
        (t: unknown) => typeof t === "string"
      ) as string[])
    : [];

  const keyDecisions = Array.isArray(s.key_decisions)
    ? (s.key_decisions as unknown[])
        .filter((d: unknown) => d && typeof d === "object")
        .map((d: unknown) => {
          const dec = d as Record<string, unknown>;
          return {
            decision: String(dec.decision || ""),
            tradeoffs: String(dec.tradeoffs || ""),
            recommendation: String(dec.recommendation || "")
          };
        })
        .filter((d) => d.decision)
    : [];

  return {
    name: s.name.trim(),
    description: s.description.trim(),
    tags,
    trigger_patterns: triggerPatterns,
    key_decisions: keyDecisions
  };
}

const VERDICT_VALUES = new Set(["new", "update", "duplicate"]);

export function validateSingleVerdict(data: unknown): CrossrefVerdict | null {
  // Handle case where LLM wraps result in an array
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    data = data[0];
  }

  if (!data || typeof data !== "object") return null;
  const v = data as Record<string, unknown>;

  if (
    typeof v.pattern_name !== "string" ||
    !VERDICT_VALUES.has(v.verdict as string) ||
    typeof v.reason !== "string"
  )
    return null;

  return {
    pattern_name: v.pattern_name,
    verdict: v.verdict as CrossrefVerdict["verdict"],
    target_skill: typeof v.target_skill === "string" ? v.target_skill : null,
    reason: v.reason,
    new_information:
      typeof v.new_information === "string" ? v.new_information : null
  };
}
