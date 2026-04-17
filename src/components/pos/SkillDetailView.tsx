"use client";

import { useState, useEffect } from "react";
import { ArrowLeft } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface SkillDetail {
  name: string;
  description: string;
  skillMd: string;
  config?: string;
  memory?: string;
  files: string[];
}

const TABS = ["Документация", "Конфиг", "Память", "Файлы"] as const;

export default function SkillDetailView({ name }: { name: string }) {
  const { setWorkspaceView } = useNavigation();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<typeof TABS[number]>("Документация");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/skills/${encodeURIComponent(name)}`)
      .then(res => res.json())
      .then(data => setDetail(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [name]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center h-full text-muted-fg text-sm">
        Скилл не найден
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-3 border-b border-border bg-surface">
        <button
          onClick={() => setWorkspaceView({ type: "welcome" })}
          className="p-1 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          title="Назад к списку"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <div className="text-sm font-medium text-foreground">{detail.name}</div>
          <div className="text-xs text-muted-fg font-mono">~/.claude/skills/{detail.name}/</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border bg-surface">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer ${
              activeTab === tab ? "bg-accent-muted text-accent-fg" : "text-muted-fg hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "Документация" && (
          <div className="md-viewer prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: detail.skillMd }} />
        )}
        {activeTab === "Конфиг" && (
          <pre className="text-sm font-mono text-foreground whitespace-pre-wrap">{detail.config || "Нет конфигурации"}</pre>
        )}
        {activeTab === "Память" && (
          <pre className="text-sm font-mono text-foreground whitespace-pre-wrap">{detail.memory || "Нет памяти"}</pre>
        )}
        {activeTab === "Файлы" && (
          <div className="space-y-1">
            {detail.files.map((f) => (
              <div key={f} className="text-sm font-mono text-muted-fg py-1">{f}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
