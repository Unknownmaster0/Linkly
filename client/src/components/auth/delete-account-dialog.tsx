"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { FormError } from "@/components/auth/form-error";
import { useAuth } from "@/providers/auth-provider";
import { ApiError } from "@/lib/api-client";

/**
 * Confirms permanent account deletion. The server re-verifies the current
 * password (defense in depth beyond the access token), then anonymizes the
 * account and soft-deletes every owned link. On success the auth provider
 * clears the session and redirects to /login. A wrong password surfaces inline
 * as "Invalid password" and keeps the user signed in (see the 401 handling in
 * lib/api-client.ts).
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { deleteAccount } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleOpenChange(next: boolean) {
    if (pending) return; // never close mid-request
    if (!next) {
      setPassword("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (!password || pending) return;
    setError(null);
    setPending(true);
    try {
      await deleteAccount(password);
      toast.success("Your account has been deleted");
      // deleteAccount() redirects to /login on success — nothing more to do.
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete your account?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently anonymizes your account and deletes all of your
            short links. This can&apos;t be undone. Enter your password to
            confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="delete-account-password">Password</Label>
          <PasswordInput
            id="delete-account-password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleConfirm();
              }
            }}
          />
          <FormError message={error} />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending || !password}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Delete account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
