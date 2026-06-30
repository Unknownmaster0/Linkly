import { Loader2 } from "lucide-react";

export function FullPageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}
