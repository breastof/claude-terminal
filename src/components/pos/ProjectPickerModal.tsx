"use client";

import { useEffect, useState, useMemo } from "react";
import { X, FolderIcon } from "@/components/Icons";
import { relativeTime } from "@/lib/utils";

interface ProjectEntry {
  path: string;
  label: string;
  kind: "project" | "service" | "sandbox";
  isGit: boolean;
  modifiedAt: number;
}

interface Props {
  open: boolean;
  providerSlug: string;
  creating: boolean;
  onClose: () => void;
  onCreate: (projectDir: string) => void;
}

const KIND_LABEL: Record<ProjectEntry["kind"], string> = {
  project: "Проекты",
  service: "Сервисы",
  sandbox: "Песочницы",
};

export default function ProjectPickerModal({ open, providerSlug, creating, onClose, onCreate }: Props) {
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setCustomPath("");
    setFilter("");
    setError(null);
    setLoading(true);
    fetch("/api/projects/list", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch failed"))))
      .then((data) => setEntries(data.entries || []))
      .catch(() => setError("Не удалось загрузить список папок"))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.label.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  const grouped = useMemo(() => {
    const out: Record<ProjectEntry["kind"], ProjectEntry[]> = {
      project: [],
      service: [],
      sandbox: [],
    };
    for (const e of filtered) out[e.kind].push(e);
    return out;
  }, [filtered]);

  if (!open) return null;

  const submit = () => {
    const finalPath = (customPath.trim() || selected || "").trim();
    if (!finalPath) {
      setError("Выбери папку или введи путь");
      return;
    }
    if (!finalPath.startsWith("/")) {
      setError("Путь должен быть абсолютным");
      return;
    }
    setError(null);
    onCreate(finalPath);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col bg-surface border border-border rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-border flex-shrink-0">
          <span className="text-sm font-medium text-foreground">
            Открыть сессию в существующей папке
          </span>
          <button
            onClick={onClose}
            className="p-1 text-muted-fg hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 pt-3 pb-2 flex-shrink-0">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Фильтр…"
            className="w-full px-3 py-1.5 text-sm bg-surface-alt border border-border rounded outline-none focus:border-accent"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
            </div>
          ) : (
            (["project", "service", "sandbox"] as const).map((kind) => {
              const items = grouped[kind];
              if (!items.length) return null;
              return (
                <div key={kind} className="mb-3">
                  <div className="px-2 py-1 text-[10px] font-medium text-muted-fg uppercase tracking-wider">
                    {KIND_LABEL[kind]}
                  </div>
                  {items.map((e) => (
                    <button
                      key={e.path}
                      onClick={() => { setSelected(e.path); setCustomPath(""); }}
                      className={`w-full text-left px-2 py-2 rounded flex items-center gap-2 hover:bg-surface-hover transition-colors ${
                        selected === e.path ? "bg-surface-hover ring-1 ring-accent" : ""
                      }`}
                    >
                      <FolderIcon className="w-4 h-4 text-muted-fg flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-foreground truncate">{e.label}</span>
                          {e.isGit && (
                            <span className="text-[9px] px-1 py-0.5 bg-emerald-500/20 text-emerald-400 rounded font-medium">
                              git
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-fg truncate">{e.path}</div>
                      </div>
                      {e.modifiedAt > 0 && (
                        <span className="text-[10px] text-muted-fg flex-shrink-0">
                          {relativeTime(new Date(e.modifiedAt).toISOString())}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              );
            })
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-fg py-8">Ничего не найдено</p>
          )}
        </div>

        <div className="border-t border-border p-3 flex-shrink-0 space-y-2">
          <input
            type="text"
            value={customPath}
            onChange={(e) => { setCustomPath(e.target.value); setSelected(null); }}
            placeholder="Свой путь, например /home/user1/services/claude-terminal"
            className="w-full px-3 py-1.5 text-sm bg-surface-alt border border-border rounded outline-none focus:border-accent font-mono"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-muted-fg hover:text-foreground transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={submit}
              disabled={creating || (!selected && !customPath.trim())}
              className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? "Создаю…" : `Создать (${providerSlug})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
