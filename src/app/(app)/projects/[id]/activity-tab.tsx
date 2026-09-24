"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { Avatar, Button, Skeleton } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { useTRPC } from "@/lib/trpc";

/** Everything that happened on the project, newest first (money entries only for people with financial access). */
export function ActivityTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useInfiniteQuery(
    trpc.projects.activity.infiniteQueryOptions(
      { projectId, limit: 40 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined },
    ),
  );
  if (q.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="serif mb-6 text-heading">
        Activity
      </h2>
      <EmailIn projectId={projectId} />
      {items.length === 0 && (
        <EmptyState
          title="Nothing yet"
          body="Changes to the project, its team and its photos will be listed here."
        />
      )}
      {items.length > 0 && (
        <ol className="divide-y divide-border rounded-card border border-border bg-surface">
          {items.map((e) => (
            <li
              key={e.seq}
              className="flex items-start gap-3 px-4 py-3 sm:px-6"
            >
              <Avatar
                name={e.actorName ?? "System"}
                size={28}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <p className="text-sm">{e.summary}</p>
                <p className="text-[12px] text-muted">
                  {formatDateTimeET(e.occurredAt)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => q.fetchNextPage()}
            loading={q.isFetchingNextPage}
          >
            Show older
          </Button>
        </div>
      )}
    </section>
  );
}

/** Module I: forward mail here and it lands in Activity, with attachments in the Inbox folder. */
function EmailIn({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.projects.inboundAddress.queryOptions({ projectId }));
  const [copied, setCopied] = useState(false);
  if (!q.data) return null;
  const address = q.data.address;
  return (
    <div className="mb-6 rounded-card border border-border bg-surface px-4 py-3 text-sm sm:px-6">
      <p className="font-medium">Email into this project</p>
      {address ? (
        <>
          <p className="mt-1 text-muted">
            Forward an email from your own address. It is saved here, and its
            attachments go to the Inbox folder.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-control bg-sunken px-2 py-1 text-[13px]">
              {address}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(address)
                  .then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-muted">
          Off for now. Email is on hold, so there is no inbound mail address
          yet. Use Files to upload instead.
        </p>
      )}
    </div>
  );
}
