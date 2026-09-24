/**
 * The iPhone app's offline queue (brief §12): ticks and comments saved on the
 * device, shown at once, sent in order when back online, and conflicts held
 * for the person instead of being applied blindly.
 */
import { beforeEach, describe, expect, it } from "vitest";

// A browser-like global for the queue (localStorage, window events, navigator).
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  window: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
});
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
  writable: true,
});

const q = await import("@/lib/offline-queue");

const P = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "33333333-3333-4333-8333-333333333333";
const trpcError = (code: string, message = code) =>
  Object.assign(new Error(message), { data: { code } });

beforeEach(() => {
  store.clear();
  q.setQueueViewer("user-1");
  q.setTaskTitleLookup((id) => (id === T1 ? "Order survey" : null));
  (navigator as { onLine: boolean }).onLine = true;
});

describe("offline queue", () => {
  it("saves ticks and comments with readable labels; a tick and untick cancel out", () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 3,
    });
    q.enqueue("tasks.addComment", {
      projectId: P,
      taskId: T2,
      body: "On site",
    });
    expect(q.readQueue().map((o) => o.label)).toEqual([
      "Tick “Order survey”",
      "Comment",
    ]);
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: false,
      version: 3,
    });
    expect(q.readQueue().map((o) => o.path)).toEqual(["tasks.addComment"]);
    expect(q.queueSnapshot()).not.toBe("");
    q.clearQueue();
    expect(q.readQueue()).toEqual([]);
    expect(q.queueSnapshot()).toBe("");
  });

  it("answers queued calls at once", () => {
    expect(
      q.queuedResult("checklist.setDone", {
        projectId: P,
        taskId: T1,
        done: true,
        version: 4,
      }),
    ).toEqual({ status: "done", version: 4, queued: true });
    expect(
      q.queuedResult("checklist.setDone", {
        projectId: P,
        taskId: T1,
        done: false,
        version: 4,
      }),
    ).toMatchObject({ status: "not_started" });
    expect(
      q.queuedResult("tasks.addComment", {
        projectId: P,
        taskId: T1,
        body: "x",
      }),
    ).toMatchObject({ queued: true });
    expect(q.isQueueable("checklist.setDone")).toBe(true);
    expect(q.isQueueable("tasks.decide")).toBe(false);
  });

  it("shows queued changes on top of fresh data", () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 1,
    });
    q.enqueue("tasks.addComment", {
      projectId: P,
      taskId: T1,
      body: "Queued note",
    });
    const cl = q.overlayQueued(
      "checklist.get",
      { projectId: P },
      {
        tasks: [
          { id: T1, status: "not_started" },
          { id: T2, status: "in_progress" },
        ],
      },
    ) as { tasks: { id: string; status: string }[] };
    expect(cl.tasks.map((t) => t.status)).toEqual(["done", "in_progress"]);
    const mine = q.overlayQueued("tasks.mine", undefined, {
      total: 2,
      sections: [
        {
          groups: [
            { tasks: [{ id: T1 }, { id: T2 }] },
            { tasks: [{ id: T1 }] },
          ],
        },
      ],
    }) as {
      total: number;
      sections: { groups: { tasks: { id: string }[] }[] }[];
    };
    expect(mine.total).toBe(0);
    expect(mine.sections[0]!.groups).toEqual([{ tasks: [{ id: T2 }] }]);
    const detail = q.overlayQueued(
      "tasks.detail",
      { projectId: P, taskId: T1 },
      { status: "not_started", comments: [{ id: "c1" }] },
    ) as {
      status: string;
      comments: { id: string; body?: string; authorName?: string }[];
    };
    expect(detail.status).toBe("done");
    expect(detail.comments).toHaveLength(2);
    expect(detail.comments[1]).toMatchObject({
      body: "Queued note",
      authorName: "You · waiting to sync",
    });
    // Other queries, other projects and empty data pass through.
    const other = { tasks: [{ id: T1, status: "not_started" }] };
    expect(q.overlayQueued("projects.get", { projectId: P }, other)).toBe(
      other,
    );
    expect(
      q.overlayQueued("checklist.get", { projectId: "someone-else" }, other),
    ).toBe(other);
    expect(q.overlayQueued("checklist.get", { projectId: P }, null)).toBeNull();
    expect(
      q.overlayQueued("checklist.get", { projectId: P }, { nope: 1 }),
    ).toEqual({ nope: 1 });
    // Another person's queue never shows.
    q.setQueueViewer("user-2");
    expect(q.overlayQueued("checklist.get", { projectId: P }, other)).toBe(
      other,
    );
  });

  it("an untick shows as not started, and a queued untick on My Tasks leaves the task there", () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: false,
      version: 5,
    });
    const cl = q.overlayQueued(
      "checklist.get",
      { projectId: P },
      { tasks: [{ id: T1, status: "done" }] },
    ) as { tasks: { status: string }[] };
    expect(cl.tasks[0]!.status).toBe("not_started");
    const mine = q.overlayQueued("tasks.mine", undefined, {
      sections: [{ groups: [{ tasks: [{ id: T1 }] }] }],
    }) as { sections: { groups: unknown[] }[] };
    expect(mine.sections[0]!.groups).toHaveLength(1);
  });

  it("sends in order, carries new versions forward, holds conflicts and failures, and stops when the connection drops", async () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 1,
    });
    q.enqueue("tasks.addComment", { projectId: P, taskId: T1, body: "first" });
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T2,
      done: true,
      version: 7,
    });
    q.enqueue("tasks.addComment", {
      projectId: P,
      taskId: T2,
      body: "refused",
    });
    const calls: string[] = [];
    const client: import("@/lib/offline-queue").QueueClient = {
      setDone: async (i) => {
        calls.push(`done ${i.taskId === T1 ? "T1" : "T2"} v${i.version}`);
        if (i.taskId === T2) throw trpcError("CONFLICT");
        return { status: "done", version: i.version + 1 };
      },
      addComment: async (i) => {
        calls.push(`comment ${i.body}`);
        if (i.body === "refused") throw trpcError("FORBIDDEN", "Not allowed");
        return { id: "c" };
      },
      latestVersion: async () => 9,
    };
    const r = await q.flushQueue(client, (e) => (e as Error).message);
    expect(calls).toEqual([
      "done T1 v1",
      "comment first",
      "done T2 v7",
      "comment refused",
    ]);
    expect(r).toEqual({ sent: 2, left: 2 });
    const left = q.readQueue();
    expect(left.map((o) => [o.state, o.message])).toEqual([
      ["conflict", "Someone changed this task while you were offline."],
      ["failed", "Not allowed"],
    ]);
    // "Tick it anyway" retries against the task as it is now.
    await q.resolveConflict(client, left[0]!.id, (e) => (e as Error).message);
    expect(calls.at(-1)).toBe("done T2 v9");
    expect(q.readQueue()[0]!.state).toBe("conflict"); // this stub keeps saying it changed
    q.removeOp(left[0]!.id);
    q.removeOp(left[1]!.id);

    // A later tick on the same task builds on the version the first one produced.
    // (Two ticks on one task only happen when the first was held back, so write them straight in.)
    const base = {
      userId: "user-1",
      queuedAt: new Date().toISOString(),
      label: "x",
      state: "pending" as const,
      path: "checklist.setDone" as const,
    };
    store.set(
      "pc.offline.queue.v1",
      JSON.stringify([
        {
          ...base,
          id: "a",
          input: { projectId: P, taskId: T1, done: true, version: 2 },
        },
        {
          ...base,
          id: "b",
          input: { projectId: P, taskId: T1, done: false, version: 2 },
        },
      ]),
    );
    const seen: number[] = [];
    await q.flushQueue(
      {
        ...client,
        setDone: async (i) => (
          seen.push(i.version),
          { status: "done", version: i.version + 1 }
        ),
      },
      String,
    );
    expect(seen).toEqual([2, 3]);

    // No connection: nothing is lost.
    q.enqueue("tasks.addComment", { projectId: P, taskId: T1, body: "later" });
    const offline = await q.flushQueue(
      {
        ...client,
        addComment: async () =>
          Promise.reject(new TypeError("Failed to fetch")),
      },
      String,
    );
    expect(offline).toEqual({ sent: 0, left: 1 });
    expect(q.readQueue()[0]!.state).toBe("pending");
  });

  it("never sends what someone else queued on this device; a new person signing in discards it; resolves only ticks", async () => {
    q.setQueueViewer("user-9");
    q.enqueue("tasks.addComment", { projectId: P, taskId: T1, body: "theirs" });
    q.setQueueViewer("user-1");
    const sentBodies: string[] = [];
    const client = {
      setDone: async () => ({ status: "done", version: 1 }),
      addComment: async (i: { body: string }) => (sentBodies.push(i.body), {}),
      latestVersion: async () => null,
    };
    expect(await q.flushQueue(client, String)).toEqual({ sent: 0, left: 0 });
    expect(sentBodies).toEqual([]);
    expect(
      q.overlayQueued(
        "tasks.detail",
        { projectId: P, taskId: T1 },
        { comments: [] },
      ),
    ).toEqual({ comments: [] });
    q.discardOthers("user-1");
    expect(q.readQueue()).toEqual([]);
    // Nothing queued for that id, or not a tick: nothing happens.
    await q.resolveConflict(client, "missing", String);
    const c = q.enqueue("tasks.addComment", {
      projectId: P,
      taskId: T1,
      body: "x",
    });
    await q.resolveConflict(client, c.id, String);
    expect(q.readQueue()).toHaveLength(1);
    // A task that's gone.
    q.clearQueue();
    const t = q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 1,
    });
    await q.resolveConflict(client, t.id, String);
    expect(q.readQueue()[0]).toMatchObject({
      state: "failed",
      message: "This task is no longer on the project.",
    });
  });

  it("holds back ticks that need a file, keeps temporary failures queued, and retries on request", async () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 1,
    });
    q.enqueue("tasks.addComment", { projectId: P, taskId: T2, body: "note" });
    const client = {
      setDone: async () => ({
        status: "needs_attachment",
        version: 1,
        label: "the signed survey",
      }),
      addComment: async () =>
        Promise.reject(trpcError("INTERNAL_SERVER_ERROR")),
      latestVersion: async () => 1,
    };
    const r = await q.flushQueue(client, String);
    expect(r).toEqual({ sent: 0, left: 2 });
    const [tick, comment] = q.readQueue();
    expect(tick).toMatchObject({
      state: "failed",
      message: "Attach the signed survey first, then tick it again.",
    });
    expect(comment).toMatchObject({ state: "pending" });
    expect((comment!.input as { clientId?: string }).clientId).toMatch(/.{8,}/);
    // A held tick isn't shown as done.
    const cl = q.overlayQueued(
      "checklist.get",
      { projectId: P },
      { tasks: [{ id: T1, status: "not_started" }] },
    ) as { tasks: { status: string }[] };
    expect(cl.tasks[0]!.status).toBe("not_started");
    q.retryOp(tick!.id);
    expect(q.readQueue()[0]).toMatchObject({ state: "pending" });
    expect(q.readQueue()[0]!.message).toBeUndefined();
    // A gateway error page (no app answer) and an ended session are temporary too.
    expect(q.isTemporary(new Error("Unexpected token <"))).toBe(true);
    expect(q.isTemporary(trpcError("UNAUTHORIZED"))).toBe(true);
    expect(q.isTemporary(trpcError("FORBIDDEN"))).toBe(false);
  });

  it("an approval task ticked by someone who can't approve shows as sent for approval", () => {
    q.enqueue("checklist.setDone", {
      projectId: P,
      taskId: T1,
      done: true,
      version: 1,
    });
    const cl = q.overlayQueued(
      "checklist.get",
      { projectId: P },
      {
        access: { canApprove: false },
        tasks: [{ id: T1, status: "not_started", requiresApproval: true }],
      },
    ) as { tasks: { status: string }[] };
    expect(cl.tasks[0]!.status).toBe("awaiting_approval");
    const approver = q.overlayQueued(
      "checklist.get",
      { projectId: P },
      {
        access: { canApprove: true },
        tasks: [{ id: T1, status: "not_started", requiresApproval: true }],
      },
    ) as { tasks: { status: string }[] };
    expect(approver.tasks[0]!.status).toBe("done");
  });

  it("tells a dropped connection from a refusal", () => {
    expect(q.isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      q.isNetworkError(
        Object.assign(new Error("x"), { cause: new TypeError("Load failed") }),
      ),
    ).toBe(true);
    expect(
      q.isNetworkError(
        new Error("NetworkError when attempting to fetch resource."),
      ),
    ).toBe(true);
    expect(q.isNetworkError(trpcError("CONFLICT"))).toBe(false);
    expect(q.isNetworkError(new Error("boom"))).toBe(false);
    (navigator as { onLine: boolean }).onLine = false;
    expect(q.isNetworkError(trpcError("CONFLICT"))).toBe(true);
  });
});
