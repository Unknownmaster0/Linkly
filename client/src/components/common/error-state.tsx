"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{title}</h3>
        {message && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          Try again
        </Button>
      )}
    </div>
  );
}
