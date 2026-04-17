"use client";

import { useState, useEffect } from "react";
import { Search, BookOpen, RefreshCw, FolderIcon, FileIcon, ChevronRight, ChevronDown } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface HubEntry {
  name: string;
  type: "file" | "directory";
  path: string;
}

export default function HubPanel() {
  const { setWorkspaceView } = useNavigation();
  const [entries, setEntries] = useState<HubEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, HubEntry[]>>({});

  const fetchEntries = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/explorer/list?root=hub&path=.");
      if (res.ok) {
        const data = await res.json();
        setEntries((data.entries || []).map((e: { name: string; type: string }) => ({
          name: e.name,
          type: e.type as "file" | "directory",
          path: e.name,
        })));
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchEntries(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/system/git/hub/sync", { method: "POST" });
      fetchEntries();
    } catch {} finally {
      setSyncing(false);
    }
  };

  const handleClick = (entry: HubEntry) => {
    if (entry.type === "file") {
      setWorkspaceView({ type: "explorer", root: "hub", openFile: entry.path });
    } else {
      // Toggle expand/collapse
      if (expanded[entry.path]) {
        setExpanded(prev => { const next = { ...prev }; delete next[entry.path]; return next; });
      } else {
        fetch(`/api/explorer/list?root=hub&path=${encodeURIComponent(entry.path)}`)
          .then(res => res.json())
          .then(data => {
            setExpanded(prev => ({
              ...prev,
              [entry.path]: (data.entries || []).map((e: { name: string; type: string }) => ({
                name: e.name,
                type: e.type,
                path: `${entry.path}/${e.name}`,
              })),
            }));
          })
          .catch(() => {});
      }
    }
  };

  const filtered = search
    ? entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;

  const renderEntry = (entry: HubEntry, depth: number = 0) => {
    const isExpanded = !!expanded[entry.path];
    const children = expanded[entry.path];
    return (
      <div key={entry.path}>
        <button
          onClick={() => handleClick(entry)}
          className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left cursor-pointer"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {entry.type === "directory" ? (
            <>
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-muted-fg flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-fg flex-shrink-0" />
              )}
              <FolderIcon className="w-4 h-4 text-accent-fg flex-shrink-0" />
            </>
          ) : (
            <>
              <span className="w-3 flex-shrink-0" />
              <FileIcon className="w-4 h-4 text-muted-fg flex-shrink-0" />
            </>
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {children && children
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map(child => renderEntry(child, depth + 1))
        }
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-accent-fg" />
          <span className="text-sm font-medium">Hub</span>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          title="Синхронизировать"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
        </button>
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
          <p className="text-muted text-sm text-center py-8">Пусто</p>
        ) : (
          filtered
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map(entry => renderEntry(entry))
        )}
      </div>
    </div>
  );
}
