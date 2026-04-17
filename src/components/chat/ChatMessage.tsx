"use client";

import { PRESENCE_COLORS } from "@/lib/presence-colors";
import { renderMarkdown } from "@/lib/markdown";
import { formatFileSize } from "@/lib/utils";
import {
  FileIcon, Download, Crown, Clipboard, LayoutIcon, Search,
  Palette, Code, Server, Eye, CheckCircle, Reply,
} from "@/components/Icons";

export interface AgentRole {
  slug: string;
  name: string;
  color: string;
  icon: string;
}

export interface ChatMessageData {
  id: number;
  text: string;
  createdAt: string;
  replyTo?: {
    id: number;
    text: string;
    user: {
      firstName: string;
      lastName: string;
      colorIndex: number;
    };
  } | null;
  user: {
    id: number;
    login: string;
    firstName: string;
    lastName: string;
    role: string;
    colorIndex?: number;
  };
  attachments: Array<{
    id: number;
    filePath: string;
    originalName: string;
    mimeType: string;
    size: number;
  }>;
  // Agent-specific fields (populated by orchestrator for symphony agents)
  agentRole?: string;
  agentColor?: string;
  agentIcon?: string;
  projectId?: number | null;
  roleColor?: string;
  roleIcon?: string;
  type?: 'casual' | 'celebration' | 'complaint' | 'insight';
}

// Map icon slugs from sym_agent_roles.icon to Icon components
const ROLE_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  "crown": Crown,
  "clipboard": Clipboard,
  "layout": LayoutIcon,
  "search": Search,
  "palette": Palette,
  "code": Code,
  "server": Server,
  "eye": Eye,
  "check-circle": CheckCircle,
};

interface RoleInfo {
  color: string;
  icon: string;
}

interface ChatMessageProps {
  message: ChatMessageData;
  onImageClick?: (src: string) => void;
  onReply?: (messageId: number) => void;
  agentRoles?: AgentRole[];
  roleMap?: Record<string, RoleInfo>;
}

export default function ChatMessage({ message, onImageClick, onReply, roleMap }: ChatMessageProps) {
  const { user, text, createdAt, attachments } = message;
  const isAgent = user.role === "agent";

  // Resolve agent color and icon: prefer embedded fields, fallback to roleMap
  const agentColor = isAgent
    ? (message.agentColor ?? message.roleColor ?? roleMap?.[message.agentRole ?? ""]?.color ?? "#6b7280")
    : null;
  const agentIconSlug = isAgent
    ? (message.agentIcon ?? message.roleIcon ?? roleMap?.[message.agentRole ?? ""]?.icon ?? null)
    : null;
  const RoleIcon = agentIconSlug ? ROLE_ICON_MAP[agentIconSlug] ?? null : null;

  // User color from presence palette
  const presenceColor = !isAgent ? PRESENCE_COLORS[(user.colorIndex ?? 0) % PRESENCE_COLORS.length] : null;

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const initial = fullName.charAt(0).toUpperCase();

  // Format time HH:MM
  const date = new Date(createdAt.endsWith("Z") ? createdAt : createdAt + "Z");
  const time = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const imageAttachments = attachments.filter((a) =>
    a.mimeType.startsWith("image/")
  );
  const fileAttachments = attachments.filter(
    (a) => !a.mimeType.startsWith("image/")
  );

  return (
    <div className={`flex gap-2.5 px-3 py-1.5 group transition-colors ${
      isAgent ? "hover:bg-surface-alt/20" : "hover:bg-surface-hover/30"
    }`}>
      {/* Avatar */}
      {isAgent ? (
        <div
          className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-medium"
          style={{ backgroundColor: agentColor ?? "#6b7280" }}
        >
          {RoleIcon ? <RoleIcon className="w-4 h-4" /> : <span>{initial}</span>}
        </div>
      ) : (
        <div
          className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-medium ${presenceColor?.bg ?? ''}`}
        >
          {initial}
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Header: name + icon + AI badge + time + reply */}
        <div className="flex items-center gap-1.5">
          <span
            className="text-sm font-medium"
            style={{ color: isAgent ? (agentColor ?? "#6b7280") : (presenceColor?.cursor ?? '') }}
          >
            {fullName}
          </span>
          {isAgent && RoleIcon && (
            <RoleIcon className="w-3 h-3 opacity-70" />
          )}
          {isAgent && (
            <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-surface-alt border border-border text-muted leading-none">
              AI
            </span>
          )}
          <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 transition-opacity ml-0.5">
            {time}
          </span>
          {onReply && (
            <button
              onClick={() => onReply(message.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-muted hover:text-foreground cursor-pointer"
              title="Ответить"
            >
              <Reply className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Reply indicator */}
        {message.replyTo && (
          <div className="flex items-center gap-1 mb-1 px-2 py-0.5 rounded bg-surface-alt/60 border-l-2 border-muted text-xs text-muted max-w-full truncate">
            <span
              className="font-medium flex-shrink-0"
              style={{
                color: PRESENCE_COLORS[message.replyTo.user.colorIndex % PRESENCE_COLORS.length].cursor,
              }}
            >
              @{[message.replyTo.user.firstName, message.replyTo.user.lastName].filter(Boolean).join(" ")}
            </span>
            <span className="truncate opacity-70">
              {message.replyTo.text.slice(0, 80)}{message.replyTo.text.length > 80 ? "..." : ""}
            </span>
          </div>
        )}

        {/* Text */}
        {text && (
          <div
            className="text-sm text-foreground leading-relaxed mt-0.5 break-words"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}

        {/* Image attachments */}
        {imageAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {imageAttachments.map((att) => (
              <button
                key={att.id}
                onClick={() =>
                  onImageClick?.(`/api/chat/uploads/${att.filePath}`)
                }
                className="block rounded-lg overflow-hidden border border-border hover:border-border-strong transition-colors cursor-pointer"
              >
                <img
                  src={`/api/chat/uploads/${att.filePath}`}
                  alt={att.originalName}
                  className="max-w-[240px] max-h-[180px] object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}

        {/* File attachments */}
        {fileAttachments.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2">
            {fileAttachments.map((att) => (
              <a
                key={att.id}
                href={`/api/chat/uploads/${att.filePath}`}
                download={att.originalName}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-alt/50 border border-border hover:border-border-strong transition-colors group/file max-w-[280px]"
              >
                <FileIcon className="w-4 h-4 text-muted-fg flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-foreground truncate">
                    {att.originalName}
                  </div>
                  <div className="text-[10px] text-muted">
                    {formatFileSize(att.size)}
                  </div>
                </div>
                <Download className="w-3.5 h-3.5 text-muted group-hover/file:text-muted-fg transition-colors flex-shrink-0" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
