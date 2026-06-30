"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
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
import { PasswordInput } from "@/components/auth/password-input";
import { FormError } from "@/components/auth/form-error";
import { useAuth } from "@/providers/auth-provider";
import { ApiError } from "@/lib/api-client";
import { loginSchema, type LoginValues } from "@/lib/validation";
import { APP_NAME } from "@/lib/config";

function safeNext(next?: string): string {
  return next && next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/dashboard";
}

export function LoginForm({ next }: { next?: string }) {
  const { login, status } = useAuth();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  // Already signed in → skip the form.
  useEffect(() => {
    if (status === "authenticated") router.replace(safeNext(next));
  }, [status, next, router]);

  async function onSubmit(values: LoginValues) {
    setFormError(null);
    try {
      await login(values.email, values.password);
      toast.success("Signed in successfully");
      router.push(safeNext(next));
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : "Something went wrong. Please try again.",
      );
    }
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
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>Password</FormLabel>
              </div>
              <FormControl>
                <PasswordInput
                  autoComplete="current-password"
                  placeholder="••••••••"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          New to {APP_NAME}?{" "}
          <Link
            href="/register"
            className="font-medium text-primary hover:underline"
          >
            Create an account
          </Link>
        </p>
      </form>
    </Form>
  );
}
