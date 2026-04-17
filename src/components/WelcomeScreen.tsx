"use client";

import { TypewriterEffect } from "@/components/ui/typewriter-effect";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { FlipWords } from "@/components/ui/flip-words";
import { Spotlight } from "@/components/ui/spotlight";
import ComboButton from "@/components/ComboButton";
import { useTheme } from "@/lib/ThemeContext";
import { themeConfigs } from "@/lib/theme-config";
import { type Provider } from "@/lib/ProviderContext";

interface WelcomeScreenProps {
  providers: Provider[];
  selectedSlug: string;
  onSelectSlug: (slug: string) => void;
  onCreateSession: (slug: string) => void;
  onAddProvider: () => void;
  onConfigureProvider: (p: Provider) => void;
  creating: boolean;
}

export default function WelcomeScreen({
  providers,
  selectedSlug,
  onSelectSlug,
  onCreateSession,
  onAddProvider,
  onConfigureProvider,
  creating,
}: WelcomeScreenProps) {
  const { theme } = useTheme();

  return (
    <div className="flex items-center justify-center h-full relative overflow-hidden px-4">
      <Spotlight
        className="-top-40 left-0 md:left-60 md:-top-20"
        fill={themeConfigs[theme].spotlightFill}
      />

      <div className="text-center max-w-md relative z-10">
        <div className="mb-4">
          <TypewriterEffect
            words={[
              { text: "Claude", className: "text-white" },
              { text: "Terminal", className: "text-accent-fg" },
            ]}
            className="text-xl md:text-2xl"
            cursorClassName="bg-accent"
          />
        </div>

        <div className="mb-2 text-muted-fg text-sm md:text-base">
          <FlipWords
            words={["Создавайте", "Исследуйте", "Автоматизируйте", "Стройте"]}
            className="text-accent-fg"
          />
          <span> с помощью AI</span>
        </div>

        <div className="mb-8">
          <TextGenerateEffect
            words="Создайте новую сессию или выберите существующую из списка слева"
            className="text-muted-fg text-sm leading-relaxed"
          />
        </div>

        <ComboButton
          providers={providers}
          selectedSlug={selectedSlug}
          onSelect={onSelectSlug}
          onCreate={onCreateSession}
          onAddProvider={onAddProvider}
          onConfigureProvider={onConfigureProvider}
          creating={creating}
          variant="welcome"
        />
      </div>
    </div>
  );
}
