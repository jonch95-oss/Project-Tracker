"use client";

/**
 * Offline check-offs and comments (brief §12). When the phone has no
 * connection, ticking a task or posting a comment is saved on the device and
 * shown as done straight away; it's sent when the connection comes back. A
 * tick on a task someone else changed in the meantime is held as a conflict
 * for the person to resolve, never applied blindly.
 *
 * The queue lives in localStorage (small, survives the app being closed) and
 * is cleared on sign-out, so the next person on a shared phone never sends
 * someone else's changes.
 */

export const QUEUEABLE = ["checklist.setDone", "tasks.addComment"] as const;
export type QueueablePath = (typeof QUEUEABLE)[number];

export interface SetDoneInput {
  projectId: string;
  taskId: string;
  done: boolean;
  version: number;
}
export interface AddCommentInput {
  projectId: string;
  taskId: string;
  body: string;
}

export type QueuedOp = {
  id: string;
  userId: string | null;
  queuedAt: string;
  /** What it was about, for the list (the task's title when known). */
  label: string;
  state: "pending" | "conflict" | "failed";
  message?: string;
} & (
  | { path: "checklist.setDone"; input: SetDoneInput }
  | { path: "tasks.addComment"; input: AddCommentInput }
);

const KEY = "pc.offline.queue.v1";
const listeners = new Set<() => void>();
let viewerId: string | null = null;
let titleOf: (taskId: string) => string | null = () => null;

export function isQueueable(path: string): path is QueueablePath {
  return (QUEUEABLE as readonly string[]).includes(path);
}

/** The signed-in person (queued items are only ever sent as them). */
export function setQueueViewer(id: string | null) {
  viewerId = id;
}
export function queueViewer(): string | null {
  return viewerId;
}

/** How to name a task in the list (looked up in what's already on screen). */
export function setTaskTitleLookup(fn: (taskId: string) => string | null) {
  titleOf = fn;
}

/** The stored queue as text (cheap to compare), "" when empty. */
export function queueSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function readQueue(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as QueuedOp[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: QueuedOp[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage full or blocked: nothing more we can do; the change stays on screen until reload.
  }
  for (const l of listeners) l();
}

export function subscribeQueue(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Save a change for later. A tick and an untick of the same task cancel out. */
export function enqueue(path: QueueablePath, input: unknown): QueuedOp {
  const list = readQueue();
  if (path === "checklist.setDone") {
    const i = input as SetDoneInput;
    const last = [...list]
      .reverse()
      .find(
        (o) =>
          o.state === "pending" &&
          o.path === "checklist.setDone" &&
          o.input.taskId === i.taskId,
      );
    if (
      last &&
      last.path === "checklist.setDone" &&
      last.input.done !== i.done
    ) {
      write(list.filter((o) => o.id !== last.id));
      return last;
    }
  }
  const taskId = (input as { taskId: string }).taskId;
  const title = titleOf(taskId);
  const op = {
    id: newId(),
    userId: viewerId,
    queuedAt: new Date().toISOString(),
    label:
      path === "tasks.addComment"
        ? `Comment${title ? ` on “${title}”` : ""}`
        : `${(input as SetDoneInput).done ? "Tick" : "Untick"}${title ? ` “${title}”` : " a task"}`,
    state: "pending",
    path,
    input,
  } as QueuedOp;
  write([...list, op]);
  return op;
}

export function updateOp(
  id: string,
  patch: Partial<Pick<QueuedOp, "state" | "message">> & { input?: unknown },
) {
  write(
    readQueue().map((o) =>
      o.id === id ? ({ ...o, ...patch } as QueuedOp) : o,
    ),
  );
}

export function removeOp(id: string) {
  write(readQueue().filter((o) => o.id !== id));
}

/** Forget everything queued (sign-out). */
export function clearQueue() {
  write([]);
}

/** What a queued call answers right away, so the screen carries on as if it went through. */
export function queuedResult(path: QueueablePath, input: unknown): unknown {
  if (path === "checklist.setDone") {
    const i = input as SetDoneInput;
    return {
      status: i.done ? "done" : "not_started",
      version: i.version,
      queued: true,
    };
  }
  return { id: `queued-${newId()}`, queued: true };
}

/* ------------------------------------------------------------------ */
/* Showing queued changes in fresh data                                */
/* ------------------------------------------------------------------ */

type AnyTask = { id: string; status?: string };
const pendingFor = (projectId?: string) =>
  readQueue().filter(
    (o) =>
      o.state !== "failed" &&
      o.userId === viewerId &&
      (!projectId || o.input.projectId === projectId),
  );

/**
 * Put queued changes on top of data read from the server (or a saved copy):
 * a checklist shows queued ticks, My Tasks drops tasks ticked off, and a task
 * shows its queued comments. Anything else passes through untouched.
 */
export function overlayQueued(
  path: string,
  input: unknown,
  data: unknown,
): unknown {
  if (!data || typeof data !== "object") return data;
  const q = pendingFor(
    (input as { projectId?: string } | undefined)?.projectId,
  );
  if (!q.length) return data;
  const ticks = new Map<string, boolean>();
  for (const o of q)
    if (o.path === "checklist.setDone") ticks.set(o.input.taskId, o.input.done);
  if (path === "checklist.get") {
    const d = data as { tasks?: AnyTask[] };
    if (!Array.isArray(d.tasks)) return data;
    return {
      ...d,
      tasks: d.tasks.map((t) =>
        ticks.has(t.id)
          ? {
              ...t,
              status: ticks.get(t.id)
                ? "done"
                : t.status === "done"
                  ? "not_started"
                  : t.status,
            }
          : t,
      ),
    };
  }
  if (path === "tasks.mine") {
    const d = data as {
      total?: number;
      sections?: { groups: { tasks: AnyTask[] }[] }[];
    };
    if (!Array.isArray(d.sections)) return data;
    let removed = 0;
    const sections = d.sections.map((s) => ({
      ...s,
      groups: s.groups
        .map((g) => {
          const tasks = g.tasks.filter((t) => ticks.get(t.id) !== true);
          removed += g.tasks.length - tasks.length;
          return { ...g, tasks };
        })
        .filter((g) => g.tasks.length),
    }));
    return {
      ...d,
      sections,
      total:
        typeof d.total === "number" ? Math.max(0, d.total - removed) : d.total,
    };
  }
  if (path === "tasks.detail") {
    const taskId = (input as { taskId?: string }).taskId;
    const d = data as { comments?: unknown[]; status?: string };
    const extra = q
      .filter((o) => o.path === "tasks.addComment" && o.input.taskId === taskId)
      .map((o) => ({
        id: `queued-${o.id}`,
        authorId: viewerId,
        authorName: "You · waiting to sync",
        body: (o.input as AddCommentInput).body,
        createdAt: new Date(o.queuedAt),
        editedAt: null,
        deletedAt: null,
        mine: false,
      }));
    const tick = taskId ? ticks.get(taskId) : undefined;
    return {
      ...d,
      ...(tick === undefined
        ? {}
        : {
            status: tick
              ? "done"
              : d.status === "done"
                ? "not_started"
                : d.status,
          }),
      ...(Array.isArray(d.comments) && extra.length
        ? { comments: [...d.comments, ...extra] }
        : {}),
    };
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

export interface QueueClient {
  setDone: (
    input: SetDoneInput,
  ) => Promise<{ status: string; version: number }>;
  addComment: (input: AddCommentInput) => Promise<unknown>;
  /** The task's current version, for "tick it anyway". */
  latestVersion: (projectId: string, taskId: string) => Promise<number | null>;
}

/** A failure that means "no connection", not "the server said no". */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return true;
  const err = e as {
    data?: unknown;
    cause?: unknown;
    message?: string;
    name?: string;
  };
  if (err?.data) return false; // the server answered
  const msg = `${err?.message ?? ""} ${(err?.cause as { message?: string } | undefined)?.message ?? ""}`;
  return (
    err?.name === "TypeError" ||
    err?.cause instanceof TypeError ||
    /Failed to fetch|NetworkError|Load failed|network connection|fetch failed/i.test(
      msg,
    )
  );
}

const codeOf = (e: unknown) => (e as { data?: { code?: string } })?.data?.code;

let running: Promise<{ sent: number; left: number }> | null = null;

/**
 * Send what's queued, oldest first. Stops at the first sign the connection
 * is gone (the rest wait for next time). A tick on a task that changed in the
 * meantime becomes a conflict; anything the server refuses becomes a failure
 * with its reason. Items saved by someone else on this device are dropped.
 */
export function flushQueue(
  client: QueueClient,
  message: (e: unknown) => string,
): Promise<{ sent: number; left: number }> {
  if (running) return running;
  running = (async () => {
    let sent = 0;
    for (const { id } of readQueue()) {
      // Read it fresh: an earlier send may have moved its version on (or removed it).
      const op = readQueue().find((o) => o.id === id);
      if (!op || op.state !== "pending") continue;
      if (!viewerId || op.userId !== viewerId) {
        removeOp(op.id);
        continue;
      }
      try {
        if (op.path === "checklist.setDone") {
          const r = await client.setDone(op.input);
          // Later queued ticks on the same task build on the new version.
          for (const next of readQueue())
            if (
              next.id !== op.id &&
              next.path === "checklist.setDone" &&
              next.input.taskId === op.input.taskId
            )
              updateOp(next.id, {
                input: { ...next.input, version: r.version },
              });
        } else {
          await client.addComment(op.input);
        }
        removeOp(op.id);
        sent++;
      } catch (e) {
        if (isNetworkError(e)) break;
        if (op.path === "checklist.setDone" && codeOf(e) === "CONFLICT")
          updateOp(op.id, {
            state: "conflict",
            message: "Someone changed this task while you were offline.",
          });
        else updateOp(op.id, { state: "failed", message: message(e) });
      }
    }
    return { sent, left: readQueue().length };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** "Tick it anyway": retry a conflicted tick against the task as it is now. */
export async function resolveConflict(
  client: QueueClient,
  id: string,
  message: (e: unknown) => string,
): Promise<void> {
  const op = readQueue().find((o) => o.id === id);
  if (!op || op.path !== "checklist.setDone") return;
  const version = await client.latestVersion(
    op.input.projectId,
    op.input.taskId,
  );
  if (version === null) {
    updateOp(id, {
      state: "failed",
      message: "This task is no longer on the project.",
    });
    return;
  }
  try {
    await client.setDone({ ...op.input, version });
    removeOp(id);
  } catch (e) {
    if (isNetworkError(e)) return;
    updateOp(id, {
      state: codeOf(e) === "CONFLICT" ? "conflict" : "failed",
      message:
        codeOf(e) === "CONFLICT"
          ? "It changed again. Try once more."
          : message(e),
    });
  }
}
