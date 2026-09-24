import { z } from "zod";

/** A calendar date the app can plan with. A mistyped year (0202, 20266) is refused rather than stretching the Gantt or breaking date math. */
export const planDate = z.iso.date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "Use a date between 2000 and 2100.");
