"use client";

import { usePresence } from "@/components/presence/PresenceProvider";
import { usePipelineAlertsSeed } from "@/hooks/usePipelineAlertsSeed";
import PipelineAlertBanner from "@/components/symphony/PipelineAlertBanner";

export default function PipelineHealth() {
  usePipelineAlertsSeed();
  const { pipelineAlerts, dismissAlert } = usePresence();

  return <PipelineAlertBanner alerts={pipelineAlerts} onDismiss={dismissAlert} />;
}
