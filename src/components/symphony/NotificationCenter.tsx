"use client";

import { useSymphony } from "@/lib/SymphonyContext";

export default function NotificationCenter({ onClose }: { onClose: () => void }) {
  const { notifications, clearNotification, setView } = useSymphony();

  const TYPE_STYLES: Record<string, { icon: string; class: string }> = {
    agent_started: { icon: "🤖", class: "text-accent-fg" },
    agent_failed: { icon: "❌", class: "text-danger" },
    epic_completed: { icon: "🎉", class: "text-success" },
    rate_limited: { icon: "⏳", class: "text-warning" },
  };

  return (
    <div className="w-80 max-h-96 bg-surface border border-border rounded-lg shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Уведомления</span>
        <button onClick={onClose} className="text-muted-fg hover:text-foreground cursor-pointer text-sm">×</button>
      </div>

      <div className="overflow-y-auto max-h-80">
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-fg text-center">Нет уведомлений</div>
        ) : (
          notifications.slice(0, 30).map(n => {
            const style = TYPE_STYLES[n.type] || { icon: "📌", class: "text-foreground" };
            return (
              <div
                key={n.id}
                onClick={() => {
                  clearNotification(n.id);
                  if (n.taskId && n.projectSlug) {
                    setView({ type: "task", slug: n.projectSlug, taskId: n.taskId });
                    onClose();
                  }
                }}
                className={`px-3 py-2 border-b border-border/30 cursor-pointer hover:bg-surface-alt/50 transition-colors ${
                  n.read ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-sm">{style.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs ${style.class} line-clamp-2`}>{n.message}</div>
                    <div className="text-[9px] text-muted mt-0.5">
                      {new Date(n.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1 flex-shrink-0" />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
