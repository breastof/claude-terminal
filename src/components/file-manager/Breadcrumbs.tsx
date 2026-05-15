"use client";

import { ChevronRight } from "@/components/Icons";

interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

const ROOT = "artifacts";

export default function Breadcrumbs({ currentPath, onNavigate }: BreadcrumbsProps) {
  // currentPath всегда начинается с "artifacts" (UI заклеил вкладку на этом
  // префиксе). Сегменты крошек — это путь ВНУТРИ artifacts/, корень показан
  // как лейбл "📁 artifacts".
  const normalized = currentPath === "." ? ROOT : currentPath;
  const allSegments = normalized.split("/").filter(Boolean);
  // Первый сегмент — это "artifacts" — корень, его не дублируем как сегмент.
  const rest = allSegments[0] === ROOT ? allSegments.slice(1) : allSegments;
  const atRoot = rest.length === 0;

  return (
    <div className="flex items-center gap-1 text-sm overflow-x-auto">
      <button
        onClick={() => onNavigate(ROOT)}
        className={`px-1.5 py-0.5 rounded transition-colors flex-shrink-0 cursor-pointer ${
          atRoot
            ? "text-foreground"
            : "text-accent-fg hover:text-accent-fg/80"
        }`}
        title="Артефакты — единственная видимая в UI папка проекта"
      >
        📁 artifacts
      </button>
      {rest.map((seg, i) => {
        const isLast = i === rest.length - 1;
        const segPath = ROOT + "/" + rest.slice(0, i + 1).join("/");

        return (
          <div key={segPath} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight className="w-3 h-3 text-muted" />
            {isLast ? (
              <span className="px-1.5 py-0.5 text-foreground">{seg}</span>
            ) : (
              <button
                onClick={() => onNavigate(segPath)}
                className="px-1.5 py-0.5 rounded text-accent-fg hover:text-accent-fg/80 transition-colors cursor-pointer"
              >
                {seg}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
