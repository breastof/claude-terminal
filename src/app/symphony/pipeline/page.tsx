"use client";

import { Suspense } from "react";
import { UserProvider } from "@/lib/UserContext";
import { ThemeProvider } from "@/lib/ThemeContext";
import PresenceProvider from "@/components/presence/PresenceProvider";
import PipelineHealth from "@/components/symphony/PipelineHealth";

export default function PipelinePage() {
  return (
    <Suspense>
      <ThemeProvider>
        <UserProvider>
          <PresenceProvider>
            <PipelineHealth />
          </PresenceProvider>
        </UserProvider>
      </ThemeProvider>
    </Suspense>
  );
}
