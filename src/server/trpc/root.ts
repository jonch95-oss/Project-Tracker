import { createCallerFactory, router } from "./init";
import { checklistRouter } from "./routers/checklist";
import { filesRouter } from "./routers/files";
import { financialsRouter } from "./routers/financials";
import { photosRouter } from "./routers/photos";
import { companiesRouter, membersRouter, projectsRouter } from "./routers/projects";
import { auditRouter, systemRouter } from "./routers/system";
import { keyDatesRouter, notificationsRouter, tasksRouter } from "./routers/tasks";
import { notifySettingsRouter, pushRouter } from "./routers/notify-settings";
import { expiriesRouter, recordsRouter } from "./routers/records";
import { templatesRouter } from "./routers/templates";
import { invitesRouter, meRouter, usersRouter } from "./routers/users";

export const appRouter = router({
  me: meRouter,
  invites: invitesRouter,
  users: usersRouter,
  companies: companiesRouter,
  projects: projectsRouter,
  members: membersRouter,
  photos: photosRouter,
  files: filesRouter,
  financials: financialsRouter,
  checklist: checklistRouter,
  templates: templatesRouter,
  tasks: tasksRouter,
  keyDates: keyDatesRouter,
  notifications: notificationsRouter,
  notifySettings: notifySettingsRouter,
  push: pushRouter,
  records: recordsRouter,
  expiries: expiriesRouter,
  audit: auditRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
