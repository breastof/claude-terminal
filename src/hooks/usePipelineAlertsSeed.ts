"use client";
import { useEffect } from "react";
import { usePresence } from "@/components/presence/PresenceProvider";

export function usePipelineAlertsSeed() {
  const { seedAlerts } = usePresence();

  useEffect(() => {
    fetch("/api/symphony/v2/alerts")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.active?.length) seedAlerts(data.active.slice(0, 10));
      })
      .catch(() => {}); // non-critical; WebSocket will catch up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only
}
