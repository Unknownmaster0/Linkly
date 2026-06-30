"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ButtonProps = React.ComponentProps<typeof Button>;

export function CopyButton({
  value,
  label = "Copy link",
  variant = "ghost",
  size = "icon-sm",
  className,
  children,
}: {
  value: string;
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleCopy}
      aria-label={label}
      className={className}
    >
      {copied ? (
        <Check className="size-4 text-success" />
      ) : (
        <Copy className="size-4" />
      )}
      {children}
    </Button>
  );
}
