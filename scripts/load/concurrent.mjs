// Brief §13: 50 people using the app at once. Each signs in, then for DURATION seconds keeps
// opening My Tasks, the Portfolio and a project (the same calls the screens make), with a short think time.
// Usage: BASE=http://localhost:3100 node scripts/load/concurrent.mjs   (against a load-seeded, non-production database)
const BASE = process.env.BASE ?? "http://localhost:3100";
const USERS = Number(process.env.USERS ?? 50);
const DURATION = Number(process.env.DURATION ?? 60) * 1000;
const THINK = Number(process.env.THINK_MS ?? 250);

const input = (n) => encodeURIComponent(JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { json: null, meta: { values: ["undefined"] } }]))));
const screens = {
  tasks: `/api/trpc/tasks.mine,tasks.needsYou?batch=1&input=${input(2)}`,
  portfolio: `/api/trpc/projects.list,tasks.needsYou,companies.list?batch=1&input=${input(3)}`,
};

async function signIn(i) {
  const email = `load${String(i).padStart(2, "0")}@demo.test`;
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: "demo password 1" }) });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const cookies = await Promise.all(Array.from({ length: USERS }, (_, i) => signIn(i + 1)));
const firstProject = await (await fetch(`${BASE}/api/trpc/projects.list?batch=1&input=${input(1)}`, { headers: { cookie: cookies[0] } })).json();
const projectIds = firstProject[0].result.data.json.projects?.map((p) => p.id) ?? firstProject[0].result.data.json.map((p) => p.id);
const lat = { tasks: [], portfolio: [], project: [] };
let errors = 0;
let requests = 0;
const end = Date.now() + DURATION;

async function user(u) {
  let k = u;
  // People don't click in lockstep: each starts at a random moment and pauses a varying time between screens.
  await new Promise((r) => setTimeout(r, Math.random() * THINK));
  while (Date.now() < end) {
    const which = ["tasks", "portfolio", "project"][k++ % 3];
    const url = which === "project" ? `/api/trpc/projects.get,checklist.get?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { projectId: projectIds[k % projectIds.length] } }, 1: { json: { projectId: projectIds[k % projectIds.length] } } }))}` : screens[which];
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + url, { headers: { cookie: cookies[u] } });
      await res.arrayBuffer();
      requests++;
      if (res.status !== 200) errors++;
    } catch {
      errors++;
    }
    lat[which].push(performance.now() - t0);
    await new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random())));
  }
}

const started = Date.now();
await Promise.all(cookies.map((_, u) => user(u)));
const secs = (Date.now() - started) / 1000;
const pct = (xs, p) => Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]);
const summary = Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: pct(xs, 1) }]));
console.log(JSON.stringify({ users: USERS, seconds: Math.round(secs), requests, perSecond: Math.round(requests / secs), errors, latencyMs: summary }, null, 1));
