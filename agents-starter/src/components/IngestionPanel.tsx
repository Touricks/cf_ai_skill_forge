import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Button, Surface, Badge } from "@cloudflare/kumo";
import {
  XIcon,
  UploadSimpleIcon,
  FileTextIcon,
  ArrowLeftIcon,
  LightningIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type { ConversationTurn, SynthesizedSkill } from "../types";

const TOKEN_BUDGET = 4000;

interface IngestionPanelProps {
  agent: { send: (data: string) => void };
  status: "idle" | "running" | "complete" | "error";
  progress: { step: string; progress: number } | null;
  error: string | null;
  synthesizedSkill: SynthesizedSkill | null;
  draftSkill: string | null;
  prefillContent: string | null;
  onPrefillConsumed: () => void;
}

// ── Turn parser ──────────────────────────────────────────────

export function parseConversationTurns(text: string): ConversationTurn[] {
  const turnRegex =
    /(?=(?:User|Human|Assistant|AI|Claude|GPT|Gemini|System)\s*:)/i;
  const parts = text.split(turnRegex).filter((p) => p.trim());

  if (parts.length <= 1) {
    // No speaker markers found — treat as single turn
    const words = text.trim().split(/\s+/).length;
    return [
      {
        index: 0,
        speaker: "Unknown",
        text: text.trim(),
        estimatedTokens: Math.ceil(words * 1.3)
      }
    ];
  }

  return parts.map((part, i) => {
    const colonIdx = part.indexOf(":");
    const speaker =
      colonIdx > 0 && colonIdx < 20
        ? part.slice(0, colonIdx).trim()
        : "Unknown";
    const body =
      colonIdx > 0 && colonIdx < 20
        ? part.slice(colonIdx + 1).trim()
        : part.trim();
    const words = body.split(/\s+/).length;
    return {
      index: i,
      speaker,
      text: body,
      estimatedTokens: Math.ceil(words * 1.3)
    };
  });
}

export function speakerVariant(
  speaker: string
): "primary" | "secondary" | "outline" {
  const s = speaker.toLowerCase();
  if (s === "user" || s === "human") return "primary";
  if (
    s === "assistant" ||
    s === "ai" ||
    s === "claude" ||
    s === "gpt" ||
    s === "gemini"
  )
    return "outline";
  return "secondary";
}

// ── Component ────────────────────────────────────────────────

type Phase = "input" | "select" | "draft";

export default function IngestionPanel({
  agent,
  status,
  progress,
  error,
  synthesizedSkill,
  draftSkill,
  prefillContent,
  onPrefillConsumed
}: IngestionPanelProps) {
  const [content, setContent] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Turn selection state
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [skillHint, setSkillHint] = useState("");

  // Auto-fill from /copy k command
  useEffect(() => {
    if (prefillContent) {
      setContent(prefillContent);
      setIsOpen(true);
      onPrefillConsumed();
    }
  }, [prefillContent]);

  const phase: Phase = useMemo(() => {
    if (synthesizedSkill || draftSkill) return "draft";
    if (turns.length > 0) return "select";
    return "input";
  }, [synthesizedSkill, draftSkill, turns.length]);

  const shouldBeOpen =
    isOpen ||
    status === "running" ||
    !!synthesizedSkill ||
    !!draftSkill ||
    turns.length > 0;

  // Token budget calculations
  const selectedTokens = useMemo(() => {
    let total = 0;
    for (const idx of selected) {
      const turn = turns.find((t) => t.index === idx);
      if (turn) total += turn.estimatedTokens;
    }
    return total;
  }, [selected, turns]);

  const overBudget = selectedTokens > TOKEN_BUDGET;

  // ── Handlers ─────────────────────────────────────────────

  const handleParse = useCallback(() => {
    if (!content.trim()) return;
    const parsed = parseConversationTurns(content.trim());
    setTurns(parsed);
    // Auto-select all turns if under budget
    const allTokens = parsed.reduce((sum, t) => sum + t.estimatedTokens, 0);
    if (allTokens <= TOKEN_BUDGET) {
      setSelected(new Set(parsed.map((t) => t.index)));
    } else {
      setSelected(new Set());
    }
  }, [content]);

  const handleExtract = useCallback(() => {
    if (selected.size === 0 || overBudget) return;
    const selectedTurns = turns
      .filter((t) => selected.has(t.index))
      .map((t) => `${t.speaker}: ${t.text}`);
    agent.send(
      JSON.stringify({
        type: "ingest",
        turns: selectedTurns,
        skillHint: skillHint.trim() || undefined
      })
    );
  }, [selected, overBudget, turns, agent, skillHint]);

  const handleBack = useCallback(() => {
    setTurns([]);
    setSelected(new Set());
    setSkillHint("");
  }, []);

  const toggleTurn = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") setContent(text);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleApprove = (skillName: string) => {
    agent.send(JSON.stringify({ type: "approve", skillName }));
    setTurns([]);
    setSelected(new Set());
    setSkillHint("");
    setContent("");
  };

  // ── Collapsed state ──────────────────────────────────────

  if (!shouldBeOpen) {
    return (
      <div className="px-5 pt-4">
        <Button
          variant="outline"
          size="sm"
          icon={<UploadSimpleIcon size={14} />}
          onClick={() => setIsOpen(true)}
        >
          Ingest Conversation
        </Button>
      </div>
    );
  }

  // ── Expanded panel ───────────────────────────────────────

  return (
    <div className="px-5 pt-4">
      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-kumo-default">
            {phase === "select"
              ? "Select Turns"
              : phase === "draft"
                ? "Skill Preview"
                : "Ingest Conversation"}
          </span>
          {phase === "input" &&
            status === "idle" &&
            !synthesizedSkill &&
            !draftSkill && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<XIcon size={14} />}
                onClick={() => {
                  setIsOpen(false);
                  setContent("");
                }}
                aria-label="Close ingestion panel"
              />
            )}
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Progress bar */}
        {status === "running" && progress && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-kumo-subtle capitalize">
                {progress.step}...
              </span>
              <span className="text-xs text-kumo-subtle">
                {progress.progress}%
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-kumo-line overflow-hidden">
              <div
                className="h-full rounded-full bg-kumo-accent transition-all duration-500"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Phase 1: Input */}
        {phase === "input" && status !== "running" && (
          <>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`relative rounded-lg border transition-colors ${
                isDragging
                  ? "border-kumo-accent bg-kumo-accent/5"
                  : "border-kumo-line"
              }`}
            >
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste an AI conversation here, or drag & drop a file..."
                rows={6}
                className="w-full px-3 py-2 text-sm rounded-lg bg-transparent text-kumo-default placeholder:text-kumo-inactive font-mono resize-y focus:outline-none"
              />
              {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-kumo-accent/10">
                  <span className="text-sm text-kumo-accent">
                    Drop file here
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleParse}
                disabled={!content.trim()}
              >
                Parse Turns
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon={<FileTextIcon size={14} />}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload File
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </div>
          </>
        )}

        {/* Phase 2: Turn Selection */}
        {phase === "select" && status !== "running" && (
          <div className="space-y-3">
            {/* Token budget bar */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-kumo-subtle">
                {selected.size} of {turns.length} turns selected
              </span>
              <span
                className={`text-xs font-mono ${overBudget ? "text-red-400" : "text-kumo-subtle"}`}
              >
                {selectedTokens.toLocaleString()} /{" "}
                {TOKEN_BUDGET.toLocaleString()} tokens
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-kumo-line overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  overBudget ? "bg-red-500" : "bg-kumo-accent"
                }`}
                style={{
                  width: `${Math.min((selectedTokens / TOKEN_BUDGET) * 100, 100)}%`
                }}
              />
            </div>

            {/* Turn cards */}
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {turns.map((turn) => (
                <label
                  key={turn.index}
                  aria-label={`Turn ${turn.index + 1} by ${turn.speaker}`}
                  className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    selected.has(turn.index)
                      ? "border-kumo-accent bg-kumo-accent/5"
                      : "border-kumo-line hover:bg-kumo-control"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(turn.index)}
                    onChange={() => toggleTurn(turn.index)}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge
                        variant={speakerVariant(turn.speaker)}
                        className="text-[10px]"
                      >
                        {turn.speaker}
                      </Badge>
                      <span className="text-[10px] text-kumo-inactive font-mono">
                        ~{turn.estimatedTokens} tok
                      </span>
                    </div>
                    <p className="text-xs text-kumo-default leading-relaxed line-clamp-3">
                      {turn.text.slice(0, 300)}
                      {turn.text.length > 300 ? "..." : ""}
                    </p>
                  </div>
                </label>
              ))}
            </div>

            {/* Skill hint */}
            <input
              type="text"
              value={skillHint}
              onChange={(e) => setSkillHint(e.target.value)}
              placeholder="What skill to capture? (e.g., 'database migration strategy')"
              className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-transparent text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring"
            />

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={<ArrowLeftIcon size={14} />}
                onClick={handleBack}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<LightningIcon size={14} weight="fill" />}
                onClick={handleExtract}
                disabled={selected.size === 0 || overBudget}
              >
                Extract Skill
              </Button>
            </div>
          </div>
        )}

        {/* Phase 3: Draft Review */}
        {phase === "draft" && status !== "running" && (
          <div className="space-y-3">
            {/* Synthesized skill summary */}
            {synthesizedSkill && (
              <div className="p-3 rounded-lg bg-kumo-control space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-kumo-default">
                    {synthesizedSkill.name}
                  </span>
                  {synthesizedSkill.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="text-[10px]"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-kumo-subtle">
                  {synthesizedSkill.description}
                </p>
                {synthesizedSkill.key_decisions.length > 0 && (
                  <div className="text-xs text-kumo-subtle">
                    <span className="font-medium">Key decisions:</span>{" "}
                    {synthesizedSkill.key_decisions
                      .map((d) => d.decision)
                      .join(" | ")}
                  </div>
                )}
              </div>
            )}

            {/* Draft markdown */}
            {draftSkill && (
              <div className="max-h-96 overflow-y-auto rounded-lg bg-kumo-base">
                <Streamdown
                  className="sd-theme rounded-lg p-3"
                  controls={false}
                >
                  {draftSkill}
                </Streamdown>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const name =
                    synthesizedSkill?.name ||
                    draftSkill?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ||
                    "untitled-skill";
                  handleApprove(name);
                }}
              >
                Approve & Save
              </Button>
            </div>
          </div>
        )}
      </Surface>
    </div>
  );
}
