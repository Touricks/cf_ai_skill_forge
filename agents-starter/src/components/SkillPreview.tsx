import { Button } from "@cloudflare/kumo";
import { ArrowLeftIcon, TrashIcon } from "@phosphor-icons/react";
import type { SkillMetadata } from "../types";
import { TAG_COLORS } from "../graph";

interface SkillPreviewProps {
  skill: SkillMetadata;
  onBack: () => void;
  onDelete: (name: string) => void;
}

export default function SkillPreview({
  skill,
  onBack,
  onDelete
}: SkillPreviewProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Back to graph"
          icon={<ArrowLeftIcon size={16} />}
          onClick={onBack}
        />
        <h2 className="text-base font-semibold text-kumo-default truncate">
          {skill.name}
        </h2>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        {skill.tags.map((tag) => {
          const tagColor =
            TAG_COLORS[tag.toLowerCase()] || TAG_COLORS.default;
          return (
            <span
              key={tag}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border"
              style={{ borderColor: tagColor, color: tagColor }}
            >
              {tag}
            </span>
          );
        })}
      </div>

      {/* Description */}
      <p className="text-sm text-kumo-subtle">{skill.description}</p>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-xs text-kumo-subtle">Version</span>
          <p className="text-kumo-default">{skill.version}</p>
        </div>
        <div>
          <span className="text-xs text-kumo-subtle">Usage</span>
          <p className="text-kumo-default">{skill.usage_count} times</p>
        </div>
        <div>
          <span className="text-xs text-kumo-subtle">Created</span>
          <p className="text-kumo-default">
            {new Date(skill.created).toLocaleDateString()}
          </p>
        </div>
        <div>
          <span className="text-xs text-kumo-subtle">Last Used</span>
          <p className="text-kumo-default">
            {new Date(skill.last_used).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Trigger Patterns */}
      {skill.trigger_patterns.length > 0 && (
        <div>
          <span className="text-xs text-kumo-subtle">Trigger Patterns</span>
          <ul className="list-disc list-inside text-xs text-kumo-subtle space-y-0.5 mt-1">
            {skill.trigger_patterns.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Dependencies */}
      {skill.dependencies.length > 0 && (
        <div>
          <span className="text-xs text-kumo-subtle">Dependencies</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {skill.dependencies.map((dep) => (
              <span
                key={dep}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs border border-kumo-line text-kumo-default"
              >
                {dep}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Delete */}
      <div className="pt-2 border-t border-kumo-line">
        <Button
          variant="secondary"
          size="sm"
          icon={<TrashIcon size={14} />}
          onClick={() => onDelete(skill.name)}
        >
          Delete Skill
        </Button>
      </div>
    </div>
  );
}
