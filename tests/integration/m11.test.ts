/**
 * Milestone 11 (Modules H, I, M, N): the calendar feed, email into a
 * project, owner analytics and the spreadsheet import.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { signWebhook } from "@/core/inbound";
import { setInboundFetcherForTests } from "@/server/services/inbound";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { resetEnvForTests } from "@/server/env";
import { emailsCountedToday } from "@/server/services/email";
import { storage } from "@/server/storage";
import {
  addMember,
  callerFor,
  companyId,
  createUser,
} from "../support/fixtures";

const { GET: feed } = await import("@/app/api/calendar/[file]/route");
const { POST: inbound } = await import("@/app/api/inbound/email/route");

type Caller = Awaited<ReturnType<typeof callerFor>>;
const today = todayET();
const SECRET = `whsec_${Buffer.from("m11-inbound-signing-secret-000000").toString("base64")}`;
const DOMAIN = "in.example.test";
/** What the receiving server records for genuine mail from the test users' domain. */
const AUTH = {
  "Authentication-Results":
    "mx.provider.test; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass (p=none) header.from=example.com",
};

async function getFeed(url: string) {
  const file = url.split("/api/calendar/")[1]!;
  return feed(new Request(url), { params: Promise.resolve({ file }) } as never);
}

let seq = 0;
async function send(
  payload: object,
  opts: { secret?: string; id?: string; at?: number } = {},
) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Date.now()}_${++seq}`;
  const ts = Math.floor((opts.at ?? Date.now()) / 1000);
  return inbound(
    new Request("http://localhost/api/inbound/email", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(ts),
        "svix-signature": signWebhook(opts.secret ?? SECRET, id, ts, body),
      },
    }),
  );
}

describe("Milestone 11", () => {
  let owner: { id: string; email: string },
    admin: { id: string; email: string },
    member: { id: string; email: string },
    outsider: { id: string; email: string },
    stranger: { id: string; email: string },
    lp: { id: string };
  let oc: Caller, ac: Caller, mc: Caller, xc: Caller, lc: Caller;
  let projectId: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    admin = await createUser("admin");
    member = await createUser("member");
    outsider = await createUser("external");
    stranger = await createUser("member");
    lp = await createUser("investor");
    oc = await callerFor(owner.id);
    ac = await callerFor(admin.id);
    mc = await callerFor(member.id);
    xc = await callerFor(outsider.id);
    lc = await callerFor(lp.id);
    projectId = (
      await oc.projects.create({
        name: `M11 ${Date.now()}`,
        address: "347 Myrtle Avenue, Brooklyn",
        type: "gut_renovation",
        companyId: await companyId(),
        toggles: [],
      })
    ).id;
    await addMember(projectId, admin.id, {
      canEditChecklist: true,
      canViewFinancials: true,
    });
    await addMember(projectId, member.id);
    await addMember(projectId, outsider.id);
  });

  describe("calendar feed (H)", () => {
    it("serves a person's own tasks and the team's dates, never money dates without the flag; revoking kills the link", async () => {
      const [mine] = await db()
        .insert(schema.task)
        .values({
          projectId,
          phaseKey: "acquisition",
          title: "Order survey",
          assigneeId: member.id,
          dueOn: addDays(today, 5),
        })
        .returning();
      await db()
        .insert(schema.task)
        .values({
          projectId,
          phaseKey: "acquisition",
          title: "Someone else's work",
          assigneeId: admin.id,
          dueOn: addDays(today, 5),
        });
      await db()
        .insert(schema.task)
        .values({
          projectId,
          phaseKey: "construction",
          title: "Plumbing inspection",
          dueOn: addDays(today, 8),
        });
      await db()
        .insert(schema.keyDate)
        .values([
          { projectId, kind: "closing", date: addDays(today, 20) },
          { projectId, kind: "loan_maturity", date: addDays(today, 40) },
        ]);

      expect(await mc.calendar.status()).toEqual({ active: false });
      const link = await mc.calendar.create();
      expect(link.webcal.startsWith("webcal:")).toBe(true);
      const res = await getFeed(link.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/calendar");
      const ics = await res.text();
      expect(ics).toContain(`UID:task-${mine!.id}@`);
      expect(ics).toContain("SUMMARY:Due: Order survey");
      expect(ics).toContain("Plumbing inspection");
      expect(ics).not.toContain("Someone else's work");
      expect(ics).toContain("Closing");
      expect(ics).not.toMatch(/maturity/i);
      expect(ics).not.toContain("$");
      expect((await mc.calendar.status()).active).toBe(true);

      // The admin (financial flag) sees the loan maturity.
      const adminIcs = await (
        await getFeed((await ac.calendar.create()).url)
      ).text();
      expect(adminIcs).toMatch(/maturity/i);

      // A new link replaces the old one; revoking kills the new one.
      const again = await mc.calendar.create();
      expect((await getFeed(link.url)).status).toBe(404);
      expect((await getFeed(again.url)).status).toBe(200);
      await mc.calendar.revoke();
      expect((await getFeed(again.url)).status).toBe(404);
      expect(
        (await getFeed("http://localhost/api/calendar/nope.ics")).status,
      ).toBe(404);
    });

    it("outside collaborators get only their own paperwork; investors get no feed", async () => {
      const ics = await (
        await getFeed((await xc.calendar.create()).url)
      ).text();
      expect(ics).not.toContain("Plumbing inspection");
      expect(ics).not.toContain("Closing");
      await expect(lc.calendar.create()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("analytics (M)", () => {
    it("is the owner's alone", async () => {
      const a = await oc.analytics.overview();
      expect(a).toHaveProperty("durations");
      expect(Array.isArray(a.stalls.byPhase)).toBe(true);
      await expect(ac.analytics.overview()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(mc.analytics.durationSuggestions()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("suggests template durations from three finished projects and saves them as a new version", async () => {
      // A copy of the flip template, so other tests keep the standard durations.
      const tpl = {
        id: (
          await oc.templates.create({
            name: `Flip copy ${Date.now()}`,
            from: { projectType: "contract_flip" },
          })
        ).id,
      };
      const def = (await oc.templates.get({ templateId: tpl.id }))
        .definition as {
        tasks: {
          key: string;
          phaseKey: string;
          due?: { from: unknown; days: number; unit?: string };
        }[];
      };
      const k =
        def.tasks.find(
          (t) =>
            t.due?.from === "phase_start" &&
            (t.due.unit ?? "business") === "calendar",
        ) ?? def.tasks.find((t) => t.due?.from === "phase_start")!;
      const unit = k.due!.unit ?? "business";
      const took = k.due!.days + 30;
      for (let i = 0; i < 3; i++) {
        const p = await oc.projects.create({
          name: `Flip ${i} ${Date.now()}`,
          address: `${i} Flip St`,
          type: "contract_flip",
          companyId: await companyId(),
          toggles: [],
          templateId: tpl.id,
        });
        const started = "2026-01-05";
        await db()
          .update(schema.projectPhase)
          .set({ startedOn: started })
          .where(
            and(
              eq(schema.projectPhase.projectId, p.id),
              eq(schema.projectPhase.key, k.phaseKey),
            ),
          );
        let done = started;
        if (unit === "calendar") done = addDays(started, took);
        else
          for (let n = 0; n < took;) {
            done = addDays(done, 1);
            const dow = new Date(`${done}T12:00:00Z`).getUTCDay();
            if (dow !== 0 && dow !== 6) n++;
          }
        await db()
          .update(schema.task)
          .set({ status: "done", completedOn: done })
          .where(
            and(
              eq(schema.task.projectId, p.id),
              eq(schema.task.templateKey, k.key),
            ),
          );
      }
      const all = await oc.analytics.durationSuggestions();
      const mine = all
        .find((t) => t.templateId === tpl.id)
        ?.suggestions.find((s) => s.templateKey === k.key);
      expect(mine).toBeDefined();
      expect(mine!.samples).toBeGreaterThanOrEqual(3);
      expect(Math.abs(mine!.suggestedDays - took)).toBeLessThanOrEqual(3); // holidays may shave a day or two
      const before = (await oc.templates.get({ templateId: tpl.id })).version;
      const r = await oc.analytics.applyDurations({
        templateId: tpl.id,
        version: before,
        changes: [{ templateKey: k.key, days: mine!.suggestedDays }],
      });
      expect(r).toEqual({ version: before + 1, changed: 1 });
      await expect(
        oc.analytics.applyDurations({
          templateId: tpl.id,
          version: before,
          changes: [{ templateKey: k.key, days: 3 }],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("import (N)", () => {
    it("imports units, budget lines and vendors row by row, reporting every rejected row", async () => {
      const units = await ac.import.commit({
        kind: "units",
        projectId,
        rows: [
          ["1A", "1", "850", "1"],
          ["1B", "1", "tiny", "1"],
          ["1A", "2", "900", "2"],
          ["", "", "", ""],
        ],
        mapping: { unit: 0, floor: 1, sf: 2, beds: 3 },
      });
      expect(units).toMatchObject({ read: 4, valid: 1, imported: 1 });
      expect(units.rejected.map((r) => r.row)).toEqual([3, 4, 5]);
      const listed = await ac.units.list({ projectId });
      expect(listed.units.map((u) => u.unit)).toContain("1A");

      const budget = await ac.import.commit({
        kind: "budget",
        projectId,
        rows: [
          ["Hard costs", "Framing", "$120,000"],
          ["Nope", "X", "1"],
        ],
        mapping: { category: 0, name: 1, originalCents: 2 },
      });
      expect(budget).toMatchObject({ imported: 1 });
      expect(budget.rejected[0]!.reasons[0]).toMatch(/Category "Nope"/);

      const name = `Imported Plumbing ${Date.now()}`;
      const vendors = await oc.import.commit({
        kind: "vendors",
        rows: [
          [name, "Plumber", "718-555-0100", "info@plumb.test"],
          [name, "", "", ""],
        ],
        mapping: { name: 0, trade: 1, phone: 2, email: 3 },
      });
      expect(vendors).toMatchObject({ imported: 1 });
      expect(vendors.rejected[0]!.reasons[0]).toMatch(/Same company/);
    });

    it("a template imports all or nothing; members can't import", async () => {
      const r = await oc.import.commit({
        kind: "template",
        templateName: `Imported flip ${Date.now()}`,
        projectType: "contract_flip",
        rows: [
          ["Acquisition", "Sign contract", "PM", "3"],
          ["Acquisition", "Order title", "PM", "5"],
          ["Sale", "List it", "Broker", "10"],
        ],
        mapping: { phase: 0, title: 1, role: 2, days: 3 },
      });
      expect(r).toMatchObject({ read: 3, valid: 3, imported: 3, rejected: [] });
      await expect(
        mc.import.commit({
          kind: "vendors",
          rows: [["X"]],
          mapping: { name: 0 },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        ac.import.commit({
          kind: "units",
          rows: [["1C"]],
          mapping: { unit: 0 },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("import (N): review fixes", () => {
    it("a re-imported budget skips lines that exist; rejected rows keep their sheet row numbers", async () => {
      const rows = [
        ["Soft costs", `Survey ${Date.now()}`, "$5,000"],
        ["Soft costs", "", "$1"],
      ];
      const first = await ac.import.commit({
        kind: "budget",
        projectId,
        rows,
        rowNumbers: [4, 9],
        mapping: { category: 0, name: 1, originalCents: 2 },
      });
      expect(first).toMatchObject({ imported: 1 });
      expect(first.rejected.map((r) => r.row)).toEqual([9]);
      const again = await ac.import.commit({
        kind: "budget",
        projectId,
        rows,
        rowNumbers: [4, 9],
        mapping: { category: 0, name: 1, originalCents: 2 },
      });
      expect(again).toMatchObject({ imported: 0 });
      expect(again.rejected.find((r) => r.row === 4)!.reasons[0]).toMatch(
        /already has a budget line/,
      );
    });

    it("a template whose tasks wait on each other is refused before anything is created", async () => {
      const name = `Looping ${Date.now()}`;
      const r = await oc.import.commit({
        kind: "template",
        templateName: name,
        projectType: "contract_flip",
        rows: [
          ["P", "A", "PM", "1", "B"],
          ["P", "B", "PM", "1", "A"],
        ],
        mapping: { phase: 0, title: 1, role: 2, days: 3, after: 4 },
      });
      expect(r.imported).toBe(0);
      expect(r.rejected[0]!.reasons[0]).toMatch(/The template isn't valid/);
      expect((await oc.templates.list()).some((t) => t.name === name)).toBe(
        false,
      );
    });

    it("projects import at most 50 at a time; nobody imports into a project they aren't on", async () => {
      const rows = Array.from({ length: 51 }, (_, i) => [
        `P${i}`,
        `${i} Road`,
        "Gut renovation",
      ]);
      await expect(
        oc.import.commit({
          kind: "projects",
          companyId: await companyId(),
          rows,
          mapping: { name: 0, address: 1, type: 2 },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // An admin not on the project sees it, but budget lines still need money access there.
      const outsiderAdmin = await callerFor((await createUser("admin")).id);
      // Refused up front, before anything about the budget (even which lines exist) is looked at.
      await expect(
        outsiderAdmin.import.commit({
          kind: "budget",
          projectId,
          rows: [["Soft costs", "X", "1"]],
          mapping: { category: 0, name: 1, originalCents: 2 },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      // The same project twice (name and address) is only created once.
      const name = `Twice ${Date.now()}`;
      const once = await oc.import.commit({
        kind: "projects",
        companyId: await companyId(),
        rows: [[name, "5 Same St", "Gut renovation"]],
        mapping: { name: 0, address: 1, type: 2 },
      });
      expect(once.imported).toBe(1);
      const twice = await oc.import.commit({
        kind: "projects",
        companyId: await companyId(),
        rows: [[name, "5 same st", "Gut renovation"]],
        mapping: { name: 0, address: 1, type: 2 },
      });
      expect(twice).toMatchObject({ imported: 0 });
      expect(twice.rejected[0]!.reasons[0]).toMatch(/already a project/);
    });
  });

  describe("email into a project (I)", () => {
    const saved = {
      domain: process.env.INBOUND_EMAIL_DOMAIN,
      secret: process.env.INBOUND_EMAIL_SECRET,
    };
    afterAll(() => {
      process.env.INBOUND_EMAIL_DOMAIN = saved.domain ?? "";
      process.env.INBOUND_EMAIL_SECRET = saved.secret ?? "";
      resetEnvForTests();
    });

    it("is off (404, no address) until both settings exist", async () => {
      process.env.INBOUND_EMAIL_DOMAIN = "";
      process.env.INBOUND_EMAIL_SECRET = "";
      resetEnvForTests();
      expect((await send({})).status).toBe(404);
      expect(await mc.projects.inboundAddress({ projectId })).toMatchObject({
        address: null,
      });
    });

    it("saves mail from a team member to Activity and the Inbox folder; everything else is refused", async () => {
      process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
      process.env.INBOUND_EMAIL_SECRET = SECRET;
      resetEnvForTests();
      const { address } = await mc.projects.inboundAddress({ projectId });
      expect(address).toMatch(/^347-myrtle-[a-z2-9]{4}@in\.example\.test$/);
      expect(await oc.projects.inboundAddress({ projectId })).toEqual({
        address,
        canChange: true,
      });
      expect((await mc.projects.inboundAddress({ projectId })).canChange).toBe(
        false,
      );
      await expect(
        xc.projects.inboundAddress({ projectId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const before = await emailsCountedToday();
      const pdf = Buffer.from("%PDF-1.4 survey").toString("base64");
      const ok = await send({
        type: "email.received",
        data: {
          email_id: `e-${Date.now()}`,
          from: `Member <${member.email.toUpperCase()}>`,
          to: [`Project <${address}>`],
          subject: "Survey from Ron",
          text: "See attached.",
          headers: AUTH,
          attachments: [
            {
              filename: "survey.pdf",
              content_type: "application/pdf",
              content: pdf,
            },
            {
              filename: "page.html",
              content_type: "text/html",
              content: Buffer.from("<script>").toString("base64"),
            },
          ],
        },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: "accepted", files: 3 });

      const folders = await mc.files.folders({ projectId });
      const inboxFolder = folders.folders.find((f) => f.name === "Inbox")!;
      expect(inboxFolder).toBeDefined();
      const files = await mc.files.list({
        projectId,
        folderId: inboxFolder.id,
      });
      const names = files.map((f) => f.name).sort();
      expect(names).toHaveLength(3);
      expect(names).toContain("survey.pdf");
      expect(names.find((n) => n.startsWith("Email "))).toMatch(
        /Survey from Ron\.txt$/,
      );
      // Nothing emailed in can render as a page from storage.
      const html = await db()
        .select()
        .from(schema.fileVersion)
        .where(eq(schema.fileVersion.originalName, "page.html"));
      expect(html.at(-1)!.contentType).not.toContain("html");
      const body = html.at(-1)!;
      expect(await storage().head(body.objectKey)).not.toBeNull();
      const activity = await mc.projects.activity({ projectId });
      expect(activity.items[0]!.summary).toMatch(
        /emailed in "Survey from Ron" with 2 attachments/,
      );
      expect(await emailsCountedToday()).toBe(before + 1);

      // The same message again is a no-op.
      const id = `dup-${Date.now()}`;
      const payload = {
        type: "email.received",
        data: {
          email_id: id,
          from: member.email,
          to: [address],
          subject: "Twice",
          text: "x",
          headers: AUTH,
        },
      };
      expect(await (await send(payload)).json()).toMatchObject({
        status: "accepted",
      });
      expect(await (await send(payload)).json()).toMatchObject({
        status: "duplicate",
      });

      const reject = async (
        from: string,
        to = address!,
        auth: object | null = AUTH,
      ) =>
        (await (
          await send({
            type: "email.received",
            data: {
              email_id: `r-${Date.now()}-${++seq}`,
              from,
              to: [to],
              subject: "Hi",
              text: "x",
              ...(auth ? { headers: auth } : {}),
            },
          })
        ).json()) as { status: string; reason?: string };
      expect(await reject("nobody@elsewhere.test")).toMatchObject({
        status: "rejected",
        reason: "The sender isn't a registered user.",
      });
      expect(await reject(stranger.email)).toMatchObject({
        status: "rejected",
        reason: "The sender isn't on this project's team.",
      });
      expect(await reject(outsider.email)).toMatchObject({
        status: "rejected",
        reason: "The sender isn't on this project's team.",
      });
      expect(
        await reject(member.email, `wrong-key-zzzz@${DOMAIN}`),
      ).toMatchObject({
        status: "rejected",
        reason: "No project has this address.",
      });
      // Anyone can type a teammate's address into From: without the receiving server's pass, it's refused.
      expect(await reject(member.email, address!, null)).toMatchObject({
        status: "rejected",
        reason:
          "The sender's address couldn't be verified (no DMARC or DKIM pass).",
      });
      expect(
        await reject(member.email, address!, {
          "Authentication-Results":
            "mx; dkim=pass header.d=evil.test; dmarc=fail header.from=example.com",
        }),
      ).toMatchObject({ status: "rejected" });
      // The owner sees every project, so their mail is accepted too.
      expect(await reject(owner.email)).toMatchObject({ status: "accepted" });
      // Refused mail is recorded, but only accepted mail holds back outgoing email.
      const rows = await db()
        .select()
        .from(schema.inboundEmail)
        .where(eq(schema.inboundEmail.projectId, projectId));
      expect(rows.filter((r) => r.status === "rejected").length).toBe(5);
      expect(await emailsCountedToday()).toBe(before + 3);
    });

    it("fetches the body and attachments when the webhook carries only metadata", async () => {
      process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
      process.env.INBOUND_EMAIL_SECRET = SECRET;
      resetEnvForTests();
      const { address } = await mc.projects.inboundAddress({ projectId });
      setInboundFetcherForTests(async (m) => ({
        ...m,
        hasBody: true,
        text: "Fetched body",
        authResults: AUTH["Authentication-Results"],
        attachments: m.attachments.map((a) => ({
          ...a,
          content: new TextEncoder().encode("PDF"),
        })),
      }));
      try {
        const r = await send({
          type: "email.received",
          data: {
            email_id: `meta-${Date.now()}`,
            from: member.email,
            to: [address],
            subject: "Metadata only",
            attachments: [
              {
                id: "att1",
                filename: "plan.pdf",
                content_type: "application/pdf",
              },
            ],
          },
        });
        expect(await r.json()).toMatchObject({ status: "accepted", files: 2 });
      } finally {
        setInboundFetcherForTests(null);
      }
    });

    it("a new address retires the old one", async () => {
      process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
      process.env.INBOUND_EMAIL_SECRET = SECRET;
      resetEnvForTests();
      const { address: old } = await mc.projects.inboundAddress({ projectId });
      await expect(
        mc.projects.newInboundAddress({ projectId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const { address: fresh } = await oc.projects.newInboundAddress({
        projectId,
      });
      expect(fresh).not.toBe(old);
      expect((await mc.projects.inboundAddress({ projectId })).address).toBe(
        fresh,
      );
      const r = await send({
        type: "email.received",
        data: {
          email_id: `old-${Date.now()}`,
          from: member.email,
          to: [old],
          subject: "Old",
          text: "x",
          headers: AUTH,
        },
      });
      expect(await r.json()).toMatchObject({
        status: "rejected",
        reason: "No project has this address.",
      });
    });

    it("refuses unsigned, stale and wrongly signed webhooks", async () => {
      process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
      process.env.INBOUND_EMAIL_SECRET = SECRET;
      resetEnvForTests();
      expect(
        (
          await send(
            { type: "email.received", data: {} },
            {
              secret: `whsec_${Buffer.from("another-secret-entirely-000000").toString("base64")}`,
            },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await send(
            { type: "email.received", data: {} },
            { at: Date.now() - 10 * 60_000 },
          )
        ).status,
      ).toBe(401);
      const unsigned = await inbound(
        new Request("http://localhost/api/inbound/email", {
          method: "POST",
          body: "{}",
        }),
      );
      expect(unsigned.status).toBe(401);
      expect(
        await (await send({ type: "email.bounced", data: {} })).json(),
      ).toMatchObject({ ignored: true });
    });
  });
});
