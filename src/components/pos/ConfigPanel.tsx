"use client";

import { useState, useEffect } from "react";
import { Settings, FileIcon, FolderIcon } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface ConfigEntry {
  name: string;
  type: "file" | "directory";
  path: string;
  icon?: string;
  readOnly?: boolean;
}

const CONFIG_TREE: ConfigEntry[] = [
  { name: "CLAUDE.md", type: "file", path: "CLAUDE.md", icon: "doc" },
  { name: "rules/", type: "directory", path: "rules" },
  { name: "settings.json", type: "file", path: "settings.json", icon: "config" },
  { name: "scripts/", type: "directory", path: "scripts", readOnly: true },
  { name: "skills/", type: "directory", path: "skills" },
];

export default function ConfigPanel() {
  const { setWorkspaceView } = useNavigation();
  const [entries, setEntries] = useState<ConfigEntry[]>(CONFIG_TREE);
  const [expanded, setExpanded] = useState<Record<string, ConfigEntry[]>>({});

  const handleClick = (entry: ConfigEntry) => {
    if (entry.type === "directory") {
      if (expanded[entry.path]) {
        setExpanded(prev => { const next = { ...prev }; delete next[entry.path]; return next; });
      } else {
        fetch(`/api/explorer/list?root=config&path=${encodeURIComponent(entry.path)}`)
          .then(res => res.json())
          .then(data => {
            setExpanded(prev => ({
              ...prev,
              [entry.path]: (data.entries || []).map((e: { name: string; type: string }) => ({
                name: e.name,
                type: e.type,
                path: `${entry.path}/${e.name}`,
                readOnly: entry.readOnly,
              })),
            }));
          })
          .catch(() => {});
      }
    } else {
      setWorkspaceView({ type: "explorer", root: "config", openFile: entry.path });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center gap-2 border-b border-border">
        <Settings className="w-4 h-4 text-accent-fg" />
        <span className="text-sm font-medium">Конфигурация</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {entries.map((entry) => (
          <div key={entry.path}>
            <button
              onClick={() => handleClick(entry)}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              {entry.type === "directory" ? (
                <FolderIcon className="w-4 h-4 text-accent-fg flex-shrink-0" />
              ) : (
                <FileIcon className="w-4 h-4 text-muted-fg flex-shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
              {entry.readOnly && (
                <span className="text-[10px] text-muted bg-surface-alt px-1 rounded ml-auto">ЧТ</span>
              )}
            </button>
            {expanded[entry.path] && (
              <div className="pl-4">
                {expanded[entry.path].map((child) => (
                  <button
                    key={child.path}
                    onClick={() => handleClick(child)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left cursor-pointer"
                  >
                    <FileIcon className="w-3.5 h-3.5 text-muted-fg flex-shrink-0" />
                    <span className="truncate">{child.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
