'use client';

import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, X } from '@/components/Icons';
import { cn, relativeTime } from '@/lib/utils';

export interface PipelineAlert {
  id: string;
  type: 'task_stalled' | 'failure_spike' | 'slots_full';
  severity: 'warning' | 'critical';
  message: string;
  task_id?: number;
  status?: string;
  role?: string;
  duration_minutes?: number;
  failure_rate?: number;
  sessions_count?: number;
  active_agents?: number;
  max_agents?: number;
  details?: Record<string, unknown>;
  created_at: string;
}

interface PipelineAlertBannerProps {
  alerts: PipelineAlert[];
  onDismiss: (id: string) => void;
}

const SEVERITY_STYLES = {
  critical: {
    container: 'bg-red-900/80 border-red-500',
    badge: 'text-red-400',
    label: 'CRITICAL',
  },
  warning: {
    container: 'bg-yellow-900/80 border-yellow-500',
    badge: 'text-yellow-400',
    label: 'WARNING',
  },
} as const;

export default function PipelineAlertBanner({ alerts, onDismiss }: PipelineAlertBannerProps) {
  const [, setTick] = useState(0);

  // Update relative timestamps every 30s
  useEffect(() => {
    if (alerts.length === 0) return;
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, [alerts.length]);

  // Auto-dismiss alerts older than 5 minutes
  const autoDismiss = useCallback(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    alerts.forEach(a => {
      if (new Date(a.created_at).getTime() < cutoff) onDismiss(a.id);
    });
  }, [alerts, onDismiss]);

  useEffect(() => {
    if (alerts.length === 0) return;
    const interval = setInterval(autoDismiss, 30_000);
    return () => clearInterval(interval);
  }, [alerts.length, autoDismiss]);

  if (alerts.length === 0) return null;

  const sorted = [...alerts]
    .sort((a, b) => {
      if (a.severity === b.severity) return b.created_at.localeCompare(a.created_at);
      return a.severity === 'critical' ? -1 : 1;
    })
    .slice(0, 10);

  return (
    <div
      className="fixed top-4 right-4 z-50 w-[480px] max-w-[calc(100vw-2rem)] space-y-1"
      role="alert"
      aria-live="polite"
    >
      <AnimatePresence>
        {sorted.map(alert => {
          const style = SEVERITY_STYLES[alert.severity];
          return (
            <motion.div
              key={alert.id}
              initial={{ opacity: 0, x: 48 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className={cn(
                'flex items-center gap-3 px-4 py-2.5 border-l-4 rounded-r backdrop-blur-sm',
                style.container
              )}
            >
              <AlertTriangle className={cn('w-4 h-4 flex-shrink-0', style.badge)} />
              <span className={cn('text-xs font-bold uppercase whitespace-nowrap', style.badge)}>
                [{style.label}]
              </span>
              <span className="text-sm text-white/90 flex-1 truncate" title={alert.message}>
                {alert.message}
              </span>
              <span className="text-xs text-white/50 whitespace-nowrap flex-shrink-0">
                {relativeTime(alert.created_at)}
              </span>
              <button
                onClick={() => onDismiss(alert.id)}
                aria-label="Dismiss alert"
                className="text-white/50 hover:text-white pl-2 flex-shrink-0 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
