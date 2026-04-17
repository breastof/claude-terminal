"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePresence } from "@/components/presence/PresenceProvider";
import { useUser } from "@/lib/UserContext";
import ChatMessage, { type ChatMessageData, type AgentRole } from "./ChatMessage";
import ChatInput from "./ChatInput";
import DateSeparator, { shouldShowDateSeparator } from "./DateSeparator";
import MediaGallery from "./MediaGallery";
import { X } from "@/components/Icons";

const ROLE_ORDER = [
  'cto', 'pm', 'scrum-master', 'analyst', 'designer',
  'frontend-dev', 'backend-dev', 'qa', 'code-reviewer', 'researcher'
];

function getRoleColorIndex(slug: string): number {
  const idx = ROLE_ORDER.indexOf(slug);
  return idx >= 0 ? idx : 0;
}

function normalizeAgentMessage(m: {
  id: number;
  project_id: number | null;
  author_role: string;
  content: string;
  type?: string;
  created_at: string;
  role_name?: string;
  role_color?: string;
  role_icon?: string;
}): ChatMessageData {
  return {
    id: m.id,
    text: m.content,
    createdAt: m.created_at,
    user: {
      id: 0,
      login: m.author_role,
      firstName: m.role_name || m.author_role,
      lastName: '',
      role: 'agent',
      colorIndex: getRoleColorIndex(m.author_role),
    },
    attachments: [],
    agentRole: m.author_role,
    projectId: m.project_id,
    roleColor: m.role_color,
    roleIcon: m.role_icon,
    type: (m.type as ChatMessageData['type']) || 'casual',
  };
}

interface ChatPanelProps {
  onImageClick?: (src: string) => void;
}

export default function ChatPanel({ onImageClick }: ChatPanelProps) {
  const [showGallery, setShowGallery] = useState(false);

  if (showGallery) {
    return (
      <MediaGallery
        onImageClick={onImageClick}
        onBack={() => setShowGallery(false)}
      />
    );
  }

  return (
    <ChatPanelMessages
      onImageClick={onImageClick}
      onToggleGallery={() => setShowGallery(true)}
    />
  );
}

interface RoleInfo {
  color: string;
  icon: string;
}

function ChatPanelMessages({
  onImageClick,
  onToggleGallery,
}: {
  onImageClick?: (src: string) => void;
  onToggleGallery: () => void;
}) {
  const { isGuest } = useUser();
  const { globalChatMessages } = usePresence();
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const messagesRef = useRef<ChatMessageData[]>([]);
  const [replyTarget, setReplyTarget] = useState<ChatMessageData | null>(null);
  const [agentRoles, setAgentRoles] = useState<AgentRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [roleMap, setRoleMap] = useState<Record<string, RoleInfo>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const initialLoadDone = useRef(false);

  const setMessagesAndRef = useCallback((updater: ChatMessageData[] | ((prev: ChatMessageData[]) => ChatMessageData[])) => {
    setMessages((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  }, []);

  const handleReply = useCallback((messageId: number) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (msg) setReplyTarget(msg);
  }, []);

  // Load agent roles for color/icon fallback
  useEffect(() => {
    fetch("/api/symphony/v2/roles")
      .then((r) => r.ok ? r.json() : { roles: [] })
      .then((data) => {
        setAgentRoles(data.roles ?? []);
        const map: Record<string, RoleInfo> = {};
        for (const role of data.roles) {
          map[role.slug] = { color: role.color, icon: role.icon };
        }
        setRoleMap(map);
      })
      .catch(() => {});
  }, []);
  // Watercooler state
  const [activeChannel, setActiveChannel] = useState<'project' | 'watercooler'>('project');
  const [watercoolerMessages, setWatercoolerMessages] = useState<ChatMessageData[]>([]);
  const [watercoolerLoading, setWatercoolerLoading] = useState(false);

  // Load initial messages
  useEffect(() => {
    fetchMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMessages = async () => {
    try {
      const res = await fetch("/api/chat/messages?limit=50");
      if (res.ok) {
        const data = await res.json();
        setMessagesAndRef(data.messages);
        setHasMore(data.messages.length >= 50);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
      // Scroll to bottom after initial load
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        initialLoadDone.current = true;
      });
    }
  };

  // Load older messages (infinite scroll up)
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);

    const oldestId = messages[0]?.id;
    const scrollEl = scrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight || 0;

    try {
      const res = await fetch(`/api/chat/messages?before=${oldestId}&limit=50`);
      if (res.ok) {
        const data = await res.json();
        if (data.messages.length === 0) {
          setHasMore(false);
        } else {
          setMessagesAndRef((prev) => [...data.messages, ...prev]);
          setHasMore(data.messages.length >= 50);
          // Preserve scroll position
          requestAnimationFrame(() => {
            if (scrollEl) {
              scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight;
            }
          });
        }
      }
    } catch {
      // Ignore
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, messages]);

  // Handle scroll — detect top (load older) and bottom (auto-scroll)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Check if at bottom (with 50px tolerance)
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    // Load older when scrolled to top
    if (el.scrollTop < 100 && hasMore && !loadingOlder) {
      loadOlder();
    }
  }, [hasMore, loadingOlder, loadOlder]);

  // Handle real-time messages via WS
  useEffect(() => {
    if (!globalChatMessages || globalChatMessages.length === 0) return;
    const latest = globalChatMessages[globalChatMessages.length - 1];

    setMessagesAndRef((prev) => {
      // Deduplicate by id
      if (prev.some((m) => m.id === latest.id)) return prev;
      return [...prev, latest];
    });

    // Auto-scroll if at bottom
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [globalChatMessages]);

  // Send message
  const handleSend = useCallback(async (text: string, files: File[]) => {
    const replyToId = replyTarget?.id ?? null;
    setReplyTarget(null);

    try {
      let res: Response;

      if (files.length > 0) {
        const formData = new FormData();
        formData.append("text", text);
        if (replyToId) formData.append("replyToId", String(replyToId));
        for (const file of files) {
          formData.append("files", file);
        }
        res = await fetch("/api/chat/messages", {
          method: "POST",
          body: formData,
        });
      } else {
        res = await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...(replyToId ? { replyToId } : {}) }),
        });
      }

      if (res.ok) {
        setReplyTarget(null);
        // Message will arrive via WS broadcast — but also add optimistically
        const data = await res.json();
        if (data.message) {
          setMessagesAndRef((prev) => {
            if (prev.some((m) => m.id === data.message.id)) return prev;
            return [...prev, data.message];
          });
          // Scroll to bottom
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          });
        }
      } else {
        const err = await res.json().catch(() => null);
        console.error("[chat] Send failed:", res.status, err);
      }
    } catch (e) {
      console.error("[chat] Send error:", e);
    }
  }, [replyTarget, setMessagesAndRef]);

  // Fetch watercooler messages
  const fetchWatercooler = useCallback(async () => {
    setWatercoolerLoading(true);
    try {
      const res = await fetch('/api/symphony/v2/chat?channel=watercooler&limit=50');
      if (res.ok) {
        const data = await res.json();
        setWatercoolerMessages((data.messages || []).map(normalizeAgentMessage));
      }
    } catch {
      // Silently fail — endpoint may not exist yet
    } finally {
      setWatercoolerLoading(false);
    }
  }, []);

  // Load watercooler on tab switch
  useEffect(() => {
    if (activeChannel === 'watercooler') {
      fetchWatercooler();
    }
  }, [activeChannel, fetchWatercooler]);

  // Real-time watercooler messages via custom event from PresenceProvider
  useEffect(() => {
    const handler = (event: Event) => {
      const msg = (event as CustomEvent<ChatMessageData>).detail;
      setWatercoolerMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      // Auto-scroll if watercooler tab active and at bottom
      if (activeChannel === 'watercooler' && isAtBottomRef.current) {
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        });
      }
    };
    window.addEventListener('symphony:watercooler-message', handler);
    return () => window.removeEventListener('symphony:watercooler-message', handler);
  }, [activeChannel]);

  const displayMessages = activeChannel === 'watercooler' ? watercoolerMessages : messages;
  const displayLoading = activeChannel === 'watercooler' ? watercoolerLoading : loading;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border">
        {/* Title row */}
        <div className="h-10 flex items-center justify-between px-4">
          <span className="text-sm font-medium text-foreground">Чат</span>
          {onToggleGallery && (
            <button
              onClick={onToggleGallery}
              className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
              title="Медиа"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
            </button>
          )}
        </div>
        {/* Tabs */}
        <div role="tablist" aria-label="Каналы чата" className="flex px-2">
          <button
            role="tab"
            aria-selected={activeChannel === 'project'}
            aria-controls="chat-panel-project"
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeChannel === 'project'
                ? 'text-foreground border-b-2 border-accent'
                : 'text-muted-fg hover:text-foreground'
            }`}
            onClick={() => setActiveChannel('project')}
          >
            💬 Проект
          </button>
          <button
            role="tab"
            aria-selected={activeChannel === 'watercooler'}
            aria-controls="chat-panel-watercooler"
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeChannel === 'watercooler'
                ? 'text-foreground border-b-2 border-purple-500'
                : 'text-muted-fg hover:text-foreground'
            }`}
            onClick={() => setActiveChannel('watercooler')}
          >
            🧊 Watercooler
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="tabpanel"
        id={`chat-panel-${activeChannel}`}
        aria-label={activeChannel === 'watercooler' ? 'Watercooler сообщения' : 'Сообщения проекта'}
        className="flex-1 overflow-y-auto overflow-x-hidden"
      >
        {displayLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
          </div>
        ) : displayMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted text-sm">
              {activeChannel === 'watercooler'
                ? 'Пока тихо в кулере... агенты заняты'
                : 'Нет сообщений'}
            </p>
          </div>
        ) : (
          <div className="py-2">
            {activeChannel === 'project' && loadingOlder && (
              <div className="flex justify-center py-2">
                <div className="animate-spin h-4 w-4 border-2 border-muted border-t-muted-fg rounded-full" />
              </div>
            )}
            {displayMessages.map((msg, i) => {
              const prevDate = i > 0 ? displayMessages[i - 1].createdAt : null;
              const showSep = shouldShowDateSeparator(prevDate, msg.createdAt);
              return (
                <div key={msg.id}>
                  {showSep && <DateSeparator date={msg.createdAt} />}
                  <ChatMessage
                    message={msg}
                    onImageClick={onImageClick}
                    onReply={handleReply}
                    agentRoles={agentRoles}
                    roleMap={roleMap}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reply banner */}
      {replyTarget && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-alt/40 text-xs text-muted">
          <div className="flex-1 min-w-0 truncate">
            <span className="text-muted-fg">Ответ </span>
            <span className="font-medium text-foreground">
              {[replyTarget.user.firstName, replyTarget.user.lastName].filter(Boolean).join(" ")}
            </span>
            <span className="ml-1 opacity-70">
              {replyTarget.text.slice(0, 80)}{replyTarget.text.length > 80 ? "…" : ""}
            </span>
          </div>
          <button
            onClick={() => setReplyTarget(null)}
            className="p-0.5 text-muted hover:text-foreground transition-colors flex-shrink-0 cursor-pointer"
            title="Отменить"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Input — hidden on watercooler (read-only) */}
      {activeChannel === 'project' && (
        <ChatInput
          disabled={isGuest}
          disabledTooltip="Зарегистрируйтесь для доступа к чату"
          onSend={handleSend}
        />
      )}
    </div>
  );
}
