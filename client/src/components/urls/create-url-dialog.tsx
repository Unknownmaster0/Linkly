"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CreateUrlForm } from "@/components/urls/create-url-form";

export function CreateUrlDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="size-4" />
            New link
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a short link</DialogTitle>
          <DialogDescription>
            Paste a long URL — optionally add a custom alias and an expiry.
          </DialogDescription>
        </DialogHeader>
        <CreateUrlForm />
      </DialogContent>
    </Dialog>
  );
}
