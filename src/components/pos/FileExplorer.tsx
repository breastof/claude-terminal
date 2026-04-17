"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { FolderIcon, FileIcon, ArrowLeft, Search, Save, X, Eye, Code, Columns } from "@/components/Icons";
import { getPreviewType, isPreviewable } from "@/lib/editor-utils";
import PreviewPanel from "@/components/file-manager/PreviewPanel";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

interface OpenTab {
  path: string;
  content: string;
  originalContent: string;
  dirty: boolean;
}

interface FileExplorerProps {
  root: string;
  initialPath?: string;
  initialFile?: string;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  noTree?: boolean;
}

const STORAGE_KEY = (root: string) => `explorer-tabs-${root}`;

export default function FileExplorer({ root, initialPath, initialFile, readOnly, onDirtyChange, noTree }: FileExplorerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || ".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Mobile: show editor instead of tree
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [previewMode, setPreviewMode] = useState<"edit" | "preview" | "split">("edit");
  const mountedRef = useRef(false);

  // Restore tabs from sessionStorage on mount
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY(root));
      if (saved) {
        const paths: string[] = JSON.parse(saved);
        if (paths.length > 0) {
          // Restore tabs by loading their content
          Promise.all(
            paths.map(async (p) => {
              try {
                const res = await fetch(`/api/explorer/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`);
                if (res.ok) {
                  const data = await res.json();
                  return { path: p, content: data.content || "", originalContent: data.content || "", dirty: false } as OpenTab;
                }
              } catch {}
              return null;
            })
          ).then((tabs) => {
            const valid = tabs.filter(Boolean) as OpenTab[];
            if (valid.length > 0) {
              setOpenTabs(valid);
              setActiveTabPath(valid[0].path);
            }
          });
        }
      }
    } catch {}
  }, [root]);

  // Save tabs to sessionStorage when they change
  useEffect(() => {
    if (!mountedRef.current) return;
    try {
      const paths = openTabs.map((t) => t.path);
      sessionStorage.setItem(STORAGE_KEY(root), JSON.stringify(paths));
    } catch {}
  }, [openTabs, root]);

  // Notify parent about dirty state
  useEffect(() => {
    const hasDirty = openTabs.some((t) => t.dirty);
    onDirtyChange?.(hasDirty);
  }, [openTabs, onDirtyChange]);

  // Open initial file if provided
  useEffect(() => {
    if (initialFile) {
      openFileByPath(initialFile);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  const fetchEntries = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const url = searchQuery
        ? `/api/explorer/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(searchQuery)}&path=${encodeURIComponent(path)}`
        : `/api/explorer/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [root, searchQuery]);

  useEffect(() => {
    fetchEntries(currentPath);
  }, [currentPath, fetchEntries]);

  const handleNavigate = (entry: FileEntry) => {
    if (entry.type === "directory") {
      const newPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
      setCurrentPath(newPath);
    } else {
      const filePath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
      openFileByPath(filePath);
    }
  };

  const openFileByPath = async (filePath: string) => {
    // If already open, just switch to it
    const existing = openTabs.find((t) => t.path === filePath);
    if (existing) {
      setActiveTabPath(filePath);
      setMobileShowEditor(true);
      if (!isPreviewable(filePath)) setPreviewMode("edit");
      return;
    }
    try {
      const res = await fetch(`/api/explorer/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        const newTab: OpenTab = {
          path: filePath,
          content: data.content || "",
          originalContent: data.content || "",
          dirty: false,
        };
        setOpenTabs((prev) => [...prev, newTab]);
        setActiveTabPath(filePath);
        setMobileShowEditor(true);
        if (isPreviewable(filePath)) setPreviewMode("preview"); else setPreviewMode("edit");
      }
    } catch {}
  };

  const handleCloseTab = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.dirty) {
      if (!confirm("Несохранённые изменения будут потеряны. Закрыть?")) return;
    }
    setOpenTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTabPath === path) {
      const remaining = openTabs.filter((t) => t.path !== path);
      setActiveTabPath(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
      if (remaining.length === 0) setMobileShowEditor(false);
    }
  };

  const handleTabContentChange = (content: string) => {
    setOpenTabs((prev) =>
      prev.map((t) =>
        t.path === activeTabPath
          ? { ...t, content, dirty: content !== t.originalContent }
          : t
      )
    );
  };

  const handleSave = async () => {
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (!tab || readOnly || !tab.dirty) return;
    setSaving(true);
    try {
      await fetch("/api/explorer/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: tab.path, content: tab.content }),
      });
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath
            ? { ...t, originalContent: t.content, dirty: false }
            : t
        )
      );
    } catch {} finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if (currentPath === "." || currentPath === "") return;
    const parts = currentPath.split("/");
    parts.pop();
    setCurrentPath(parts.length === 0 ? "." : parts.join("/"));
  };

  const breadcrumbs = currentPath === "." ? [root] : [root, ...currentPath.split("/")];
  const activeTab = openTabs.find((t) => t.path === activeTabPath);
  const fileName = (path: string) => path.split("/").pop() || path;

  // === MOBILE: show editor full width ===
  // On mobile (<md), if mobileShowEditor and there's an active tab, show editor full width
  // Otherwise show file tree full width

  return (
    <div className="flex h-full">
      {/* File Tree (left panel) — hidden when noTree (sidebar acts as tree) */}
      {!noTree && (
      <div className={`${mobileShowEditor && activeTab ? "hidden md:flex" : "flex"} flex-col w-full md:w-[250px] md:min-w-[200px] md:max-w-[300px] flex-shrink-0 border-r border-border`}>
        {/* Tree toolbar */}
        <div className="h-10 px-3 flex items-center gap-2 border-b border-border bg-surface">
          <button
            onClick={handleBack}
            disabled={currentPath === "."}
            className="p-0.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer disabled:opacity-30"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-0.5 text-xs text-muted-fg overflow-hidden flex-1">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-muted">/</span>}
                <span className={i === breadcrumbs.length - 1 ? "text-foreground truncate" : "truncate"}>{crumb}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="px-2 py-1.5 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
            <input
              type="text"
              placeholder="Поиск..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-7 pr-2 py-1 text-xs bg-surface-alt border border-border rounded outline-none focus:border-accent text-foreground placeholder:text-muted"
            />
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted text-xs text-center py-8">Пусто</p>
          ) : (
            entries
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map((entry) => (
                <button
                  key={entry.name}
                  onClick={() => handleNavigate(entry)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover transition-colors text-left cursor-pointer"
                >
                  {entry.type === "directory" ? (
                    <FolderIcon className="w-3.5 h-3.5 text-accent-fg flex-shrink-0" />
                  ) : (
                    <FileIcon className="w-3.5 h-3.5 text-muted-fg flex-shrink-0" />
                  )}
                  <span className="text-xs text-foreground truncate flex-1">{entry.name}</span>
                  {entry.size !== undefined && (
                    <span className="text-[10px] text-muted flex-shrink-0">
                      {entry.size < 1024 ? `${entry.size}B` : `${(entry.size / 1024).toFixed(1)}K`}
                    </span>
                  )}
                </button>
              ))
          )}
        </div>
      </div>
      )}

      {/* Editor Panel (right) */}
      <div className={`${noTree ? "flex" : (mobileShowEditor && activeTab ? "flex" : "hidden md:flex")} flex-col flex-1 min-w-0`}>
        {/* Tab bar */}
        {openTabs.length > 0 && (
          <div className="h-9 flex items-center bg-surface border-b border-border overflow-x-auto">
            {/* Mobile back button */}
            <button
              onClick={() => setMobileShowEditor(false)}
              className="md:hidden p-1.5 text-muted-fg hover:text-foreground flex-shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            {openTabs.map((tab) => (
              <button
                key={tab.path}
                onClick={() => setActiveTabPath(tab.path)}
                className={`group flex items-center gap-1.5 px-3 py-1 text-xs border-r border-border flex-shrink-0 transition-colors cursor-pointer ${
                  tab.path === activeTabPath
                    ? "bg-surface-alt text-foreground"
                    : "text-muted-fg hover:text-foreground hover:bg-surface-hover"
                }`}
              >
                <span className="truncate max-w-[120px]">{fileName(tab.path)}</span>
                {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" />}
                <span
                  onClick={(e) => handleCloseTab(tab.path, e)}
                  className="p-0.5 rounded hover:bg-surface-hover text-muted-fg hover:text-foreground flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Editor content */}
        {activeTab ? (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Editor toolbar */}
            <div className="h-8 px-3 flex items-center justify-between border-b border-border bg-surface">
              <span className="text-[10px] font-mono text-muted-fg truncate">{activeTab.path}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                {isPreviewable(activeTab.path) && (
                  <div className="flex items-center border border-border rounded overflow-hidden">
                    <button onClick={() => setPreviewMode("edit")} className={`p-0.5 px-1.5 cursor-pointer ${previewMode === "edit" ? "bg-accent-muted text-accent-fg" : "text-muted-fg hover:text-foreground"}`} title="Код"><Code className="w-3 h-3" /></button>
                    <button onClick={() => setPreviewMode("split")} className={`p-0.5 px-1.5 cursor-pointer ${previewMode === "split" ? "bg-accent-muted text-accent-fg" : "text-muted-fg hover:text-foreground"}`} title="Сплит"><Columns className="w-3 h-3" /></button>
                    <button onClick={() => setPreviewMode("preview")} className={`p-0.5 px-1.5 cursor-pointer ${previewMode === "preview" ? "bg-accent-muted text-accent-fg" : "text-muted-fg hover:text-foreground"}`} title="Просмотр"><Eye className="w-3 h-3" /></button>
                  </div>
                )}
                {activeTab.dirty && <span className="text-[10px] text-warning">Изменён</span>}
                {!readOnly && (
                  <button
                    onClick={handleSave}
                    disabled={saving || !activeTab.dirty}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-accent text-white rounded hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Save className="w-3 h-3" />
                    {saving ? "..." : "Сохранить"}
                  </button>
                )}
              </div>
            </div>
            {/* Editor + Preview */}
            <div className="flex-1 overflow-hidden flex">
              {previewMode !== "preview" && (
                <textarea
                  value={activeTab.content}
                  onChange={(e) => handleTabContentChange(e.target.value)}
                  readOnly={readOnly}
                  className={`${previewMode === "split" ? "w-1/2 border-r border-border" : "w-full"} h-full p-4 bg-surface-alt text-foreground font-mono text-sm resize-none outline-none`}
                  onKeyDown={(e) => {
                    if (e.ctrlKey && e.key === "s") {
                      e.preventDefault();
                      handleSave();
                    }
                  }}
                />
              )}
              {previewMode !== "edit" && isPreviewable(activeTab.path) && (
                <div className={`${previewMode === "split" ? "w-1/2" : "w-full"} h-full overflow-y-auto`}>
                  <PreviewPanel
                    content={activeTab.content}
                    previewType={getPreviewType(activeTab.path)}
                    sessionId=""
                    filePath={activeTab.path}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-fg text-sm">
            Выберите файл
          </div>
        )}
      </div>
    </div>
  );
}
