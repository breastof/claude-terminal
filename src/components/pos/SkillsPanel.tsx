"use client";

import { useState, useEffect } from "react";
import { Puzzle, Search } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface Skill {
  name: string;
  description: string;
  trigger?: string;
}

export default function SkillsPanel() {
  const { setWorkspaceView } = useNavigation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch("/api/skills")
      .then(res => res.json())
      .then(data => setSkills(data.skills || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = search
    ? skills.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase()))
    : skills;

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center gap-2 border-b border-border">
        <Puzzle className="w-4 h-4 text-accent-fg" />
        <span className="text-sm font-medium">Скиллы</span>
        <span className="text-xs text-muted ml-auto">{skills.length}</span>
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
          <p className="text-muted text-sm text-center py-8">Нет скиллов</p>
        ) : (
          filtered.map((skill) => (
            <button
              key={skill.name}
              onClick={() => setWorkspaceView({ type: "skill", name: skill.name })}
              className="w-full px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              <div className="text-sm font-medium text-foreground">{skill.name}</div>
              <div className="text-xs text-muted-fg mt-0.5 line-clamp-2">{skill.description}</div>
              {skill.trigger && (
                <div className="text-[10px] text-accent-fg mt-1 font-mono">/{skill.trigger}</div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
