"use client";

import { useEffect, useState, useCallback } from "react";
import { ServerPulse, RefreshCw } from "@/components/Icons";
import type { ServiceSnapshot, ServicesResponse } from "@/lib/services";
import ServiceCard from "@/components/services/ServiceCard";
import LogsModal from "@/components/services/LogsModal";

const POLL_INTERVAL = 10_000;

export default function ServicesPanel() {
  const [services, setServices] = useState<ServiceSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await fetch("/api/services");
      const data: ServicesResponse | { error: string } = await res.json();
      if (!res.ok || !("services" in data)) {
        setError("error" in data ? data.error : "request_failed");
        return;
      }
      setServices(data.services);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServices();
    const t = setInterval(fetchServices, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [fetchServices]);

  const lastCheck = services?.[0]?.status.lastCheck;

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center justify-between border-b border-border bg-surface">
        <div className="flex items-center gap-2">
          <ServerPulse className="w-4 h-4 text-accent-fg" />
          <span className="text-sm font-medium text-foreground">Сервисы</span>
          {lastCheck && (
            <span className="text-[10px] text-muted ml-2 font-mono">
              {new Date(lastCheck).toLocaleTimeString("ru-RU")}
            </span>
          )}
        </div>
        <button
          onClick={fetchServices}
          className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          title="Обновить"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex justify-center">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl w-full content-start">
          {loading && !services ? (
            <div className="col-span-full flex items-center justify-center h-full">
              <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
            </div>
          ) : error ? (
            <div className="col-span-full text-sm text-danger text-center py-8">
              Не удалось загрузить статус: {error}
            </div>
          ) : !services || services.length === 0 ? (
            <div className="col-span-full text-sm text-muted-fg text-center py-8">
              Сервисы не настроены
            </div>
          ) : (
            services.map((svc) => (
              <ServiceCard
                key={svc.id}
                service={svc}
                onShowLogs={(id, name) => setLogsTarget({ id, name })}
                onActionDone={fetchServices}
              />
            ))
          )}
        </div>
      </div>

      {logsTarget && (
        <LogsModal
          serviceId={logsTarget.id}
          serviceName={logsTarget.name}
          onClose={() => setLogsTarget(null)}
        />
      )}
    </div>
  );
}
