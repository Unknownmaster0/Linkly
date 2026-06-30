import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  hint?: string;
  className?: string;
}) {
  return (
    <Card className={cn("surface-gradient", className)}>
      <CardContent className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {Icon && (
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4.5" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
