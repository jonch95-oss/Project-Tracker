import { createCallerFactory, router } from "./init";
import { checklistRouter } from "./routers/checklist";
import { filesRouter } from "./routers/files";
import { photosRouter } from "./routers/photos";
import { companiesRouter, membersRouter, projectsRouter } from "./routers/projects";
import { auditRouter, systemRouter } from "./routers/system";
import { keyDatesRouter, notificationsRouter, tasksRouter } from "./routers/tasks";
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
  checklist: checklistRouter,
  templates: templatesRouter,
  tasks: tasksRouter,
  keyDates: keyDatesRouter,
  notifications: notificationsRouter,
  audit: auditRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
