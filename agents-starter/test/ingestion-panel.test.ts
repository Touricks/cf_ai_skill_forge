import { describe, it, expect } from "vitest";
import {
  parseConversationTurns,
  speakerVariant
} from "../src/components/IngestionPanel";

// ── parseConversationTurns ───────────────────────────────────

describe("parseConversationTurns", () => {
  it("splits User/Assistant conversation into turns", () => {
    const input = "User: hello\nAssistant: hi there\nUser: thanks";
    const turns = parseConversationTurns(input);
    expect(turns).toHaveLength(3);
    expect(turns[0].speaker).toBe("User");
    expect(turns[0].text).toBe("hello");
    expect(turns[1].speaker).toBe("Assistant");
    expect(turns[1].text).toBe("hi there");
    expect(turns[2].speaker).toBe("User");
    expect(turns[2].text).toBe("thanks");
  });

  it("recognizes Claude as speaker in multi-turn", () => {
    const input = "User: help me\nClaude: I can help with that";
    const turns = parseConversationTurns(input);
    expect(turns[1].speaker).toBe("Claude");
  });

  it("recognizes Human as speaker", () => {
    const input = "Human: what is this?\nAssistant: it's a test";
    const turns = parseConversationTurns(input);
    expect(turns[0].speaker).toBe("Human");
  });

  it("recognizes GPT and Gemini as speakers", () => {
    const input = "GPT: answer one\nGemini: answer two";
    const turns = parseConversationTurns(input);
    expect(turns[0].speaker).toBe("GPT");
    expect(turns[1].speaker).toBe("Gemini");
  });

  it("returns single Unknown turn for text without markers", () => {
    const input = "Just some plain text without any speaker markers.";
    const turns = parseConversationTurns(input);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe("Unknown");
    expect(turns[0].text).toBe(input);
  });

  it("calculates estimated tokens as ceil(words * 1.3)", () => {
    const input = "User: hello world\nAssistant: hi back";
    const turns = parseConversationTurns(input);
    // "hello world" = 2 words → ceil(2 * 1.3) = 3
    expect(turns[0].estimatedTokens).toBe(Math.ceil(2 * 1.3));
  });

  it("assigns sequential indices starting from 0", () => {
    const input = "User: first\nAssistant: second\nUser: third";
    const turns = parseConversationTurns(input);
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("handles multi-line turn content", () => {
    const input = "User: line one\nand line two\nAssistant: response";
    const turns = parseConversationTurns(input);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toContain("line one");
    expect(turns[0].text).toContain("and line two");
  });
});

// ── speakerVariant ───────────────────────────────────────────

describe("speakerVariant", () => {
  it('returns "primary" for User', () => {
    expect(speakerVariant("User")).toBe("primary");
  });

  it('returns "primary" for Human', () => {
    expect(speakerVariant("Human")).toBe("primary");
  });

  it('returns "outline" for Assistant', () => {
    expect(speakerVariant("Assistant")).toBe("outline");
  });

  it('returns "outline" for Claude', () => {
    expect(speakerVariant("Claude")).toBe("outline");
  });

  it('returns "outline" for GPT', () => {
    expect(speakerVariant("GPT")).toBe("outline");
  });

  it('returns "outline" for AI', () => {
    expect(speakerVariant("AI")).toBe("outline");
  });

  it('returns "outline" for Gemini', () => {
    expect(speakerVariant("Gemini")).toBe("outline");
  });

  it('returns "secondary" for unknown speaker', () => {
    expect(speakerVariant("System")).toBe("secondary");
  });

  it("is case insensitive", () => {
    expect(speakerVariant("user")).toBe("primary");
    expect(speakerVariant("ASSISTANT")).toBe("outline");
    expect(speakerVariant("claude")).toBe("outline");
  });

  it('returns "secondary" for empty string', () => {
    expect(speakerVariant("")).toBe("secondary");
  });
});
