"use client";

import { Suspense } from "react";
import { UserProvider } from "@/lib/UserContext";
import { ThemeProvider } from "@/lib/ThemeContext";
import PresenceProvider from "@/components/presence/PresenceProvider";
import PipelineHealth from "@/components/symphony/PipelineHealth";

export default function SymphonyPage() {
  return (
    <Suspense>
      <ThemeProvider>
        <UserProvider>
          <PresenceProvider>
            <SymphonyPageInner />
          </PresenceProvider>
        </UserProvider>
      </ThemeProvider>
    </Suspense>
  );
}

function SymphonyPageInner() {
  return (
    <div className="min-h-screen bg-background">
      <PipelineHealth />
      <div className="p-6">
        <h1 className="text-2xl font-bold text-foreground">Pipeline Dashboard</h1>
      </div>
    </div>
  );
}
