"use client";

import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { PipelineAlert } from "@/components/presence/PresenceProvider";

const ALERT_CONFIG: Record<string, { icon: string; borderColor: string; bgColor: string; iconColor: string }> = {
  task_stalled: { icon: "⚠", borderColor: "border-l-warning", bgColor: "bg-warning/10", iconColor: "text-warning" },
  failure_spike: { icon: "●", borderColor: "border-l-danger", bgColor: "bg-danger/10", iconColor: "text-danger" },
  slots_full: { icon: "▲", borderColor: "border-l-orange-400", bgColor: "bg-orange-400/10", iconColor: "text-orange-400" },
};

function AlertToast({ alert, onDismiss }: { alert: PipelineAlert; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 300_000); // 5 min auto-dismiss
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const config = ALERT_CONFIG[alert.type] ?? ALERT_CONFIG.task_stalled;
  const age = Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60000);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className={`group relative bg-surface border border-border rounded-[var(--th-radius)] shadow-[var(--th-shadow-sm)] border-l-4 ${config.borderColor} p-3 backdrop-blur-sm`}
      role="alert"
    >
      <button
        onClick={onDismiss}
        className="absolute top-2 right-2 p-1 text-muted-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Dismiss alert"
      >
        ✕
      </button>

      <div className="flex items-start gap-2 pr-6">
        <span className={`text-sm ${config.iconColor} flex-shrink-0 mt-0.5`}>{config.icon}</span>
        <div className="min-w-0">
          <p className="text-sm text-foreground leading-snug">{alert.message}</p>
          {alert.role && <p className="text-xs text-muted-fg mt-1">Role: {alert.role}</p>}
        </div>
      </div>

      <p className="text-xs text-muted-fg mt-1.5 text-right">
        {age < 1 ? "just now" : `${age}min ago`}
      </p>
    </motion.div>
  );
}

export default function PipelineAlerts({
  alerts,
  onDismiss,
}: {
  alerts: PipelineAlert[];
  onDismiss: (id: string) => void;
}) {
  if (alerts.length === 0) return null;

  const visible = alerts.slice(-5);

  return (
    <div
      className="fixed top-16 right-3 z-[60] w-full max-w-[360px] sm:w-[360px] flex flex-col gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
      aria-label="Pipeline alerts"
    >
      <AnimatePresence mode="popLayout">
        {visible.map((alert) => (
          <div key={alert.id} className="pointer-events-auto">
            <AlertToast alert={alert} onDismiss={() => onDismiss(alert.id)} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
