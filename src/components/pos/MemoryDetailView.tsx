"use client";

import { useState, useEffect } from "react";
import { ArrowLeft } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";
import MarkdownPreview from "@/components/file-manager/MarkdownPreview";

interface MemoryDetail {
  projectKey: string;
  displayName: string;
  content: string;
  files: string[];
}

export default function MemoryDetailView({ projectKey }: { projectKey: string }) {
  const { setWorkspaceView } = useNavigation();
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/explorer/read?root=memory&path=${encodeURIComponent(projectKey)}/memory/MEMORY.md`)
      .then(res => res.json())
      .then(data => setDetail({
        projectKey,
        displayName: decodeProjectKey(projectKey),
        content: data.content || "",
        files: data.files || [],
      }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center gap-3 border-b border-border bg-surface">
        <button
          onClick={() => setWorkspaceView({ type: "welcome" })}
          className="p-1 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <div className="text-sm font-medium text-foreground">{detail?.displayName || projectKey}</div>
          <div className="text-xs text-muted-fg font-mono">~/.claude/projects/{projectKey}/memory/MEMORY.md</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {detail?.content ? (
          <div className="md-viewer prose prose-sm max-w-none">
            <MarkdownPreview content={detail.content} filePath="MEMORY.md" />
          </div>
        ) : (
          <p className="text-muted text-sm text-center py-8">Нет содержимого</p>
        )}
      </div>
    </div>
  );
}

function decodeProjectKey(key: string): string {
  // -root-projects-claude-terminal → claude-terminal
  // -root-projects-Claude-11-03-2026-17-31-25 → Claude/11-03-2026-17-31-25
  const stripped = key.replace(/^-root-projects-/, "");
  // Split only on the first dash that separates project name from session ID (date pattern)
  const match = stripped.match(/^(.+?)-(\d{2}-\d{2}-\d{4}-.+)$/);
  if (match) return `${match[1]}/${match[2]}`;
  return stripped;
}
