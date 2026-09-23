import { createCallerFactory, router } from "./init";
import { photosRouter } from "./routers/photos";
import { companiesRouter, membersRouter, projectsRouter } from "./routers/projects";
import { auditRouter, systemRouter } from "./routers/system";
import { invitesRouter, meRouter, usersRouter } from "./routers/users";

export const appRouter = router({
  me: meRouter,
  invites: invitesRouter,
  users: usersRouter,
  companies: companiesRouter,
  projects: projectsRouter,
  members: membersRouter,
  photos: photosRouter,
  audit: auditRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
