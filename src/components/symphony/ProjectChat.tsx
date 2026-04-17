"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage } from "@/lib/SymphonyContext";

const ROLE_COLORS: Record<string, string> = {
  pm: "#8b5cf6",
  cto: "#7c3aed",
  "scrum-master": "#06b6d4",
  analyst: "#f59e0b",
  designer: "#ec4899",
  "frontend-dev": "#3b82f6",
  "backend-dev": "#10b981",
  reviewer: "#f97316",
  qa: "#14b8a6",
  researcher: "#6366f1",
};
const DEFAULT_COLOR = '#6366f1';

interface RoleInfo {
  slug: string;
  name: string;
  color: string;
  icon: string | null;
}

export default function ProjectChat({ slug }: { slug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [roleMap, setRoleMap] = useState<Record<string, RoleInfo>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/symphony/v2/roles', { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.roles) {
          const map: Record<string, RoleInfo> = {};
          for (const r of data.roles) map[r.slug] = r;
          setRoleMap(map);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/chat`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch {}
  }, [slug]);

  useEffect(() => { fetchMessages(); }, [fetchMessages]);

  // WS updates
  useEffect(() => {
    const handler = () => fetchMessages();
    window.addEventListener("symphony:chat-message", handler);
    return () => window.removeEventListener("symphony:chat-message", handler);
  }, [fetchMessages]);

  // Auto scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;
    await fetch(`/api/symphony/v2/projects/${slug}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: input }),
    });
    setInput("");
    fetchMessages();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border text-xs font-medium text-foreground">
        Чат проекта
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {messages.map((m) => {
          const color = m.author_role ? (roleMap[m.author_role]?.color ?? DEFAULT_COLOR) : "#71717a";
          return (
            <div key={m.id} className="text-xs">
              <span className="font-medium" style={{ color: color || "#71717a" }}>
                {m.author_role && roleMap[m.author_role]?.icon && (
                  <span className="mr-1">{roleMap[m.author_role]?.icon}</span>
                )}
                {m.author_role || "user"}
              </span>
              <span className="text-[9px] text-muted ml-1.5">
                {new Date(m.created_at + "Z").toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              </span>
              <div className="text-foreground mt-0.5">{m.content}</div>
            </div>
          );
        })}
      </div>

      <div className="p-2 border-t border-border">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleSend(); }}
            placeholder="Сообщение..."
            className="flex-1 px-2 py-1 text-xs bg-surface-alt border border-border rounded outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
          <button
            onClick={handleSend}
            className="px-2 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 cursor-pointer"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}
