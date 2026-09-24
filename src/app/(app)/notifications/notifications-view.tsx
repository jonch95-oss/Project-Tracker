"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { Button, Skeleton } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useTRPC } from "@/lib/trpc";

/** The in-app notification list. Push, the digest and preferences come in Milestone 7. */
export function NotificationsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: [...trpc.notifications.list.queryKey(), "infinite"],
    queryFn: ({ pageParam }) => qc.fetchQuery(trpc.notifications.list.queryOptions({ limit: 30, cursor: pageParam ?? undefined })),
    initialPageParam: null as { at: string; id: string } | null,
    getNextPageParam: (last) => last.next,
  });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.notifications.list.queryKey() }), qc.invalidateQueries({ queryKey: trpc.notifications.unreadCount.queryKey() })]);
  const markRead = useMutation(trpc.notifications.markRead.mutationOptions({ onSettled: refresh }));
  const markAll = useMutation(trpc.notifications.markAllRead.mutationOptions({ onSettled: refresh }));

  if (q.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <EmptyState title="Nothing yet" body="When someone assigns you a task, mentions you or needs your approval, it shows here." />;
  const unread = items.some((n) => !n.readAt);

  return (
    <div>
      {unread && (
        <div className="mb-4 flex justify-end">
          <Button variant="ghost" size="sm" loading={markAll.isPending} onClick={() => markAll.mutate()}>
            Mark all read
          </Button>
        </div>
      )}
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {items.map((n) => {
          const body = (
            <>
              <span className={cn("mt-2 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[15px] leading-snug", !n.readAt && "font-medium")}>{n.title}</span>
                {n.body && <span className="mt-0.5 block line-clamp-2 text-[13px] text-muted">{n.body}</span>}
                <span className="num mt-1 block text-[12px] text-faint">{formatDateTimeET(n.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </span>
              {!n.readAt && <span className="sr-only">Unread</span>}
            </>
          );
          const cls = "flex w-full items-start gap-3 px-4 py-4 text-left hover:bg-sunken/60 sm:px-5";
          const read = () => !n.readAt && markRead.mutate({ ids: [n.id] });
          return (
            <li key={n.id}>
              {n.href ? (
                <Link href={n.href} onClick={read} className={cls}>
                  {body}
                </Link>
              ) : (
                <button type="button" onClick={read} className={cls}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}
