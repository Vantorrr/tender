"use client";

import { aiFailureBannerText } from "@/lib/ai-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function AiFailureBanner({
  status,
  pending,
  onRetry,
}: {
  status: string;
  pending?: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert
      className="border-amber-300 bg-amber-50 text-amber-950"
      data-testid="ai-failure-banner"
    >
      <AlertTitle>{aiFailureBannerText(status)}</AlertTitle>
      <AlertDescription>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={pending}
          data-testid="ai-failure-retry"
          onClick={onRetry}
        >
          {pending ? "Повторяю…" : "Повторить"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
