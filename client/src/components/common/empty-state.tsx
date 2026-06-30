import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 px-6 py-16 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" />
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{title}</h3>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
