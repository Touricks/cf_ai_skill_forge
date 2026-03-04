import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { Button, Badge, InputArea, Empty } from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  BrainIcon,
  CaretDownIcon,
  LightningIcon
} from "@phosphor-icons/react";
import ThemeToggle from "./components/ThemeToggle";
import ToolPartView from "./components/ToolPartView";
import IngestionPanel from "./components/IngestionPanel";
import GraphView from "./components/GraphView";
import SkillPreview from "./components/SkillPreview";
import type { SynthesizedSkill, SkillForgeState, SkillMetadata } from "./types";
import { TAG_COLORS } from "./graph";

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ingestion state
  const [ingestionStatus, setIngestionStatus] = useState<
    "idle" | "running" | "complete" | "error"
  >("idle");
  const [ingestionProgress, setIngestionProgress] = useState<{
    step: string;
    progress: number;
  } | null>(null);
  const [ingestionError, setIngestionError] = useState<string | null>(null);
  const [synthesizedSkill, setSynthesizedSkill] =
    useState<SynthesizedSkill | null>(null);
  const [draftSkill, setDraftSkill] = useState<string | null>(null);

  // Graph panel state
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<Partial<SkillForgeState>>({});

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback(
      (state: unknown) => setAgentState((state ?? {}) as Partial<SkillForgeState>),
      []
    ),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          switch (data.type) {
            case "ingestion_started":
              setIngestionStatus("running");
              setIngestionError(null);
              setIngestionProgress({ step: "starting", progress: 0 });
              break;
            case "ingestion_progress":
              setIngestionProgress({
                step: data.step,
                progress: data.progress
              });
              break;
            case "skill_synthesized":
              setSynthesizedSkill(data.skill || null);
              setDraftSkill(data.markdown || null);
              setIngestionStatus("complete");
              setIngestionProgress(null);
              break;
            case "skill_saved":
              setSynthesizedSkill(null);
              setDraftSkill(null);
              setIngestionStatus("idle");
              break;
            case "skill_deleted":
              setIngestionStatus("idle");
              break;
            case "error":
              setIngestionError(data.message);
              if (ingestionStatus === "running") {
                setIngestionStatus("error");
              }
              setIngestionProgress(null);
              break;
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [ingestionStatus]
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

  // Read graph data & skills from agent state (synced via onStateUpdate)
  const graphNodes = agentState.graphData?.nodes ?? [];
  const graphEdges = agentState.graphData?.edges ?? [];
  const skills: SkillMetadata[] = agentState.skills ?? [];

  // Collect unique tags for filter chips
  const allTags = Array.from(new Set(skills.flatMap((s) => s.tags)));

  // Compute filtered node IDs when a tag filter is active
  const filteredNodeIds = activeTagFilter
    ? new Set(
        skills
          .filter((s) =>
            s.tags.some((t) => t.toLowerCase() === activeTagFilter.toLowerCase())
          )
          .map((s) => s.name)
      )
    : null;

  // Find selected skill for preview
  const previewSkill = selectedSkill
    ? skills.find((s) => s.name === selectedSkill) ?? null
    : null;

  const handleNodeClick = useCallback((id: string) => {
    setSelectedSkill(id);
  }, []);

  const handleBackFromPreview = useCallback(() => {
    setSelectedSkill(null);
  }, []);

  const handleDeleteSkill = useCallback(
    (name: string) => {
      agent.send(JSON.stringify({ type: "delete_skill", skillName: name }));
      setSelectedSkill(null);
    },
    [agent]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Re-focus the input after streaming ends
  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              <span className="mr-2">
                <LightningIcon
                  size={20}
                  weight="fill"
                  className="inline text-orange-500"
                />
              </span>
              Skill Forge
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Skills
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <span className="text-xs text-kumo-subtle">
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Disconnect banner */}
      {!connected && (
        <div className="bg-yellow-600/20 border-b border-yellow-600/40 px-4 py-2 text-center text-sm text-yellow-400">
          Connection lost. Reconnecting...
        </div>
      )}

      {/* Two-panel layout */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Left panel — Ingestion + Chat */}
        <div className="w-full md:w-3/5 h-1/2 md:h-auto flex flex-col min-w-0">
          {/* Ingestion Panel */}
          <div className="px-5">
            <IngestionPanel
              agent={agent}
              status={ingestionStatus}
              progress={ingestionProgress}
              error={ingestionError}
              synthesizedSkill={synthesizedSkill}
              draftSkill={draftSkill}
            />
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<ChatCircleDotsIcon size={32} />}
                  title="Start a conversation"
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      {[
                        "What skills do I have?",
                        "Search for React patterns",
                        "Help me refine a skill",
                        "Show my skill repository"
                      ].map((prompt) => (
                        <Button
                          key={prompt}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming}
                          onClick={() => {
                            sendMessage({
                              role: "user",
                              parts: [
                                {
                                  type: "text",
                                  text: prompt
                                }
                              ]
                            });
                          }}
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {/* Tool parts */}
                    {message.parts.filter(isToolUIPart).map((part) => (
                      <ToolPartView
                        key={part.toolCallId}
                        part={part}
                        addToolApprovalResponse={addToolApprovalResponse}
                      />
                    ))}

                    {/* Reasoning parts */}
                    {message.parts
                      .filter(
                        (part) =>
                          part.type === "reasoning" &&
                          (part as { text?: string })?.text?.trim()
                      )
                      .map((part, i) => {
                        const reasoning = part as {
                          type: "reasoning";
                          text: string;
                          state?: "streaming" | "done";
                        };
                        const isDone = reasoning.state === "done" || !isStreaming;
                        return (
                          <div key={i} className="flex justify-start">
                            <details className="max-w-[85%] w-full" open={!isDone}>
                              <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                                <BrainIcon size={14} className="text-purple-400" />
                                <span className="font-medium text-kumo-default">
                                  Reasoning
                                </span>
                                {isDone ? (
                                  <span className="text-xs text-kumo-success">
                                    Complete
                                  </span>
                                ) : (
                                  <span className="text-xs text-kumo-brand">
                                    Thinking...
                                  </span>
                                )}
                                <CaretDownIcon
                                  size={14}
                                  className="ml-auto text-kumo-inactive"
                                />
                              </summary>
                              <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                                {reasoning.text}
                              </pre>
                            </details>
                          </div>
                        );
                      })}

                    {/* Text parts */}
                    {message.parts
                      .filter((part) => part.type === "text")
                      .map((part, i) => {
                        const text = (
                          part as {
                            type: "text";
                            text: string;
                          }
                        ).text;
                        if (!text) return null;

                        if (isUser) {
                          return (
                            <div key={i} className="flex justify-end">
                              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                                {text}
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div key={i} className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                              <Streamdown
                                className="sd-theme rounded-2xl rounded-bl-md p-3"
                                controls={false}
                                isAnimating={isLastAssistant && isStreaming}
                              >
                                {text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="Send a message..."
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop generation"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
          </div>
        </div>

        {/* Right panel — Graph / Skill Preview */}
        <div className="w-full md:w-2/5 h-1/2 md:h-auto flex flex-col border-t md:border-t-0 md:border-l border-kumo-line bg-kumo-elevated">
          {previewSkill ? (
            <SkillPreview
              skill={previewSkill}
              onBack={handleBackFromPreview}
              onDelete={handleDeleteSkill}
            />
          ) : (
            <>
              {/* Tag filter chips */}
              {allTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-kumo-line">
                  <button
                    type="button"
                    onClick={() => setActiveTagFilter(null)}
                    className="cursor-pointer"
                  >
                    <Badge variant={activeTagFilter === null ? "primary" : "secondary"}>
                      All
                    </Badge>
                  </button>
                  {allTags.map((tag) => {
                    const isActive =
                      activeTagFilter?.toLowerCase() === tag.toLowerCase();
                    const tagColor =
                      TAG_COLORS[tag.toLowerCase()] || TAG_COLORS.default;
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          setActiveTagFilter((prev) =>
                            prev?.toLowerCase() === tag.toLowerCase()
                              ? null
                              : tag
                          )
                        }
                        className="cursor-pointer"
                      >
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                            isActive
                              ? "bg-kumo-contrast text-kumo-inverse"
                              : ""
                          }`}
                          style={
                            isActive
                              ? undefined
                              : { borderColor: tagColor, color: tagColor }
                          }
                        >
                          {tag}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Graph */}
              <GraphView
                nodes={graphNodes}
                edges={graphEdges}
                onNodeClick={handleNodeClick}
                filteredNodeIds={filteredNodeIds}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
