/**
 * Task dependencies (brief §5.4, §6): a task can't be checked off until the
 * tasks it depends on are done, and the reason is shown. Dependencies must
 * never form a cycle. Pure graph helpers over string ids.
 */

export type Edges = ReadonlyMap<string, readonly string[]>; // task → tasks it depends on

export function edgesFrom(pairs: readonly { taskId: string; dependsOnId: string }[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const { taskId, dependsOnId } of pairs) {
    const list = m.get(taskId) ?? [];
    if (!list.includes(dependsOnId)) list.push(dependsOnId);
    m.set(taskId, list);
  }
  return m;
}

/** Would adding "task depends on dependsOn" create a cycle (including a self-dependency)? */
export function wouldCreateCycle(edges: Edges, task: string, dependsOn: string): boolean {
  if (task === dependsOn) return true;
  // A cycle appears if `task` is already reachable from `dependsOn`.
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === task) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/** The dependency chain that would close a cycle, for an error message (task → … → task). */
export function cyclePath(edges: Edges, task: string, dependsOn: string): string[] | null {
  if (task === dependsOn) return [task, task];
  const prev = new Map<string, string>();
  const queue = [dependsOn];
  const seen = new Set([dependsOn]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === task) {
      const path = [task];
      let p = task;
      while (p !== dependsOn) {
        p = prev.get(p)!;
        path.push(p);
      }
      return [task, ...path.reverse()];
    }
    for (const next of edges.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Any cycle in a whole graph (for validating templates); null when acyclic. */
export function findCycle(nodes: Iterable<string>, edges: Edges): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const d of edges.get(n) ?? []) {
      const s = state.get(d);
      if (s === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!s) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

/** Dependencies of `task` that are not finished yet — the reason it's blocked. */
export function unmetDependencies(edges: Edges, task: string, isDone: (id: string) => boolean): string[] {
  return (edges.get(task) ?? []).filter((d) => !isDone(d));
}

/** Tasks that depend on `task` (directly). */
export function dependents(edges: Edges, task: string): string[] {
  const out: string[] = [];
  for (const [t, deps] of edges) if (deps.includes(task)) out.push(t);
  return out;
}

/** Dependency-respecting order (dependencies first); ties keep the input order. Throws on a cycle. */
export function topoOrder(nodes: readonly string[], edges: Edges): string[] {
  const cycle = findCycle(nodes, edges);
  if (cycle) throw new Error(`Dependency cycle: ${cycle.join(" → ")}`);
  const out: string[] = [];
  const done = new Set<string>();
  const known = new Set(nodes);
  const visit = (n: string) => {
    if (done.has(n)) return;
    done.add(n);
    for (const d of edges.get(n) ?? []) if (known.has(d)) visit(d);
    out.push(n);
  };
  for (const n of nodes) visit(n);
  return out;
}
