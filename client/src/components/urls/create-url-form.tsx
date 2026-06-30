"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BarChart3,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormError } from "@/components/auth/form-error";
import { CopyButton } from "@/components/common/copy-button";
import { useCreateUrl } from "@/hooks/use-create-url";
import { ApiError } from "@/lib/api-client";
import { LIMITS } from "@/lib/config";
import { prettyUrl } from "@/lib/format";
import { createUrlSchema, type CreateUrlValues } from "@/lib/validation";
import type { ShortenResult } from "@/lib/api-types";

const TTL_OPTIONS = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
];

export function CreateUrlForm({
  onCreated,
}: {
  onCreated?: (result: ShortenResult) => void;
}) {
  const createUrl = useCreateUrl();
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<ShortenResult | null>(null);

  const form = useForm<CreateUrlValues>({
    resolver: zodResolver(createUrlSchema),
    defaultValues: { url: "", customAlias: "", ttlDays: LIMITS.defaultTtlDays },
  });

  async function onSubmit(values: CreateUrlValues) {
    setFormError(null);
    const alias = values.customAlias?.trim();
    try {
      const result = await createUrl.mutateAsync({
        url: values.url.trim(),
        customAlias: alias ? alias : undefined,
        ttlDays: values.ttlDays,
      });
      setCreated(result);
      onCreated?.(result);
      toast.success("Short link created");
      form.reset({ url: "", customAlias: "", ttlDays: values.ttlDays });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) {
          setFormError(
            error.retryAfter
              ? `Rate limit reached. Try again in ${error.retryAfter}s.`
              : "Rate limit reached. Please slow down and try again.",
          );
        } else if (error.field === "customAlias" || error.field === "url") {
          form.setError(error.field, { message: error.message });
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    }
  }

  if (created) {
    return <CreatedResult result={created} onReset={() => setCreated(null)} />;
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <FormError message={formError} />

        <FormField
          control={form.control}
          name="url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Destination URL</FormLabel>
              <FormControl>
                <Input
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/a/very/long/link"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="customAlias"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Custom alias{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="my-project" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="ttlDays"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Expires in</FormLabel>
                <Select
                  value={String(field.value ?? LIMITS.defaultTtlDays)}
                  onValueChange={(value) => field.onChange(Number(value))}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {TTL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={String(option.value)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Shorten URL
        </Button>
      </form>
    </Form>
  );
}

function CreatedResult({
  result,
  onReset,
}: {
  result: ShortenResult;
  onReset: () => void;
}) {
  return (
    <div className="animate-in-up space-y-4">
      <p className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success">
        <CheckCircle2 className="size-4 shrink-0" />
        Your short link is ready
      </p>

      <div className="rounded-lg border bg-muted/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <a
            href={result.shortUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate font-medium text-primary hover:underline"
          >
            {result.shortUrl}
          </a>
          <CopyButton value={result.shortUrl} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {prettyUrl(result.originalUrl)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={result.shortUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            Open
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/analytics/${result.shortCode}`}>
            <BarChart3 className="size-4" />
            View analytics
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw className="size-4" />
          Create another
        </Button>
      </div>
    </div>
  );
}
