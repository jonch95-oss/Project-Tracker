"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { Avatar, Button, Skeleton } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { useTRPC } from "@/lib/trpc";

/** Everything that happened on the project, newest first (money entries only for people with financial access). */
export function ActivityTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useInfiniteQuery(
    trpc.projects.activity.infiniteQueryOptions({ projectId, limit: 40 }, { getNextPageParam: (last) => last.nextCursor ?? undefined }),
  );
  if (q.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <EmptyState title="Nothing yet" body="Changes to the project, its team and its photos will be listed here." />;
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="serif mb-6 text-heading">
        Activity
      </h2>
      <ol className="divide-y divide-border rounded-card border border-border bg-surface">
        {items.map((e) => (
          <li key={e.seq} className="flex items-start gap-3 px-4 py-3 sm:px-6">
            <Avatar name={e.actorName ?? "System"} size={28} className="mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm">{e.summary}</p>
              <p className="text-[12px] text-muted">{formatDateTimeET(e.occurredAt)}</p>
            </div>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      )}
    </section>
  );
}
