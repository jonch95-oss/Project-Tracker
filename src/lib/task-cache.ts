"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

/**
 * Everything that shows task state: after any task change, refresh all of it
 * so My Tasks, the Needs-you rail, the checklist, the task sheet, cards and
 * the inbox never disagree.
 */
export function useInvalidateTaskViews() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.tasks.mine.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.tasks.needsYou.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.tasks.detail.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.checklist.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.keyDates.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.notifications.unreadCount.queryKey() }),
    ]);
}
