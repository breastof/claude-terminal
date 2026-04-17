"use client";

import { useState, useEffect } from "react";
import { Brain, Search } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface MemoryEntry {
  projectKey: string;
  displayName: string;
  lastModified: string;
  preview: string;
  isOrphan?: boolean;
}

export default function MemoryPanel() {
  const { setWorkspaceView } = useNavigation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch("/api/memory")
      .then(res => res.json())
      .then(data => setEntries(data.entries || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const orphanCount = entries.filter(e => e.isOrphan).length;
  const filtered = search
    ? entries.filter(e => e.displayName.toLowerCase().includes(search.toLowerCase()) || e.projectKey.toLowerCase().includes(search.toLowerCase()))
    : entries;

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center gap-2 border-b border-border">
        <Brain className="w-4 h-4 text-accent-fg" />
        <span className="text-sm font-medium">Память</span>
        <div className="flex items-center gap-1.5 ml-auto">
          {orphanCount > 0 && (
            <span className="text-[10px] bg-danger/20 text-danger px-1.5 py-0.5 rounded-full">
              {orphanCount} потер.
            </span>
          )}
          <span className="text-xs text-muted">{entries.length}</span>
        </div>
      </div>

      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
          <input
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted text-sm text-center py-8">Нет памяти</p>
        ) : (
          filtered.map((entry) => (
            <button
              key={entry.projectKey}
              onClick={() => setWorkspaceView({ type: "memory", projectKey: entry.projectKey })}
              className="w-full px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">{entry.displayName}</span>
                {entry.isOrphan && (
                  <span className="text-[10px] bg-danger/20 text-danger px-1 rounded flex-shrink-0">потерян</span>
                )}
              </div>
              <div className="text-xs text-muted-fg mt-0.5 line-clamp-1">{entry.preview}</div>
              <div className="text-[10px] text-muted mt-0.5">{entry.lastModified}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
