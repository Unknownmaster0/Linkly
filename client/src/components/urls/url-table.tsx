"use client";

import Link from "next/link";
import {
  BarChart3,
  ExternalLink,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";
import { expiryLabel, formatDate, formatNumber, isExpired, prettyUrl } from "@/lib/format";
import type { UrlListItem } from "@/lib/api-types";

export function UrlTable({
  urls,
  onDelete,
}: {
  urls: UrlListItem[];
  onDelete: (url: UrlListItem) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Short link</TableHead>
            <TableHead className="hidden md:table-cell">Destination</TableHead>
            <TableHead className="text-right">Clicks</TableHead>
            <TableHead className="hidden sm:table-cell">Status</TableHead>
            <TableHead className="hidden lg:table-cell">Created</TableHead>
            <TableHead className="w-10 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {urls.map((url) => (
            <UrlRow key={url.shortCode} url={url} onDelete={onDelete} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function UrlRow({
  url,
  onDelete,
}: {
  url: UrlListItem;
  onDelete: (url: UrlListItem) => void;
}) {
  const expired = isExpired(url.expiresAt);
  const slug = url.customAlias ?? url.shortCode;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1">
          <Link
            href={`/analytics/${url.shortCode}`}
            className="font-medium hover:text-primary"
          >
            /{slug}
          </Link>
          <CopyButton value={url.shortUrl} size="icon-xs" />
        </div>
      </TableCell>

      <TableCell className="hidden max-w-[22rem] md:table-cell">
        <a
          href={url.originalUrl}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-muted-foreground hover:text-foreground"
          title={url.originalUrl}
        >
          {prettyUrl(url.originalUrl)}
        </a>
      </TableCell>

      <TableCell className="text-right font-medium tabular-nums">
        {formatNumber(url.clickCount)}
      </TableCell>

      <TableCell className="hidden sm:table-cell">
        <Badge
          variant={expired ? "destructive" : "outline"}
          className={cn(
            !expired && "border-success/30 bg-success/10 text-success",
          )}
          title={expiryLabel(url.expiresAt)}
        >
          {expired ? "Expired" : "Active"}
        </Badge>
      </TableCell>

      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {formatDate(url.createdAt)}
      </TableCell>

      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Link actions">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <a href={url.shortUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open link
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/analytics/${url.shortCode}`}>
                <BarChart3 />
                View analytics
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onDelete(url)}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
