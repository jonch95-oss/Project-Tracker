"use server";

import { createFirstOwnerInvite, type SetupResult } from "@/server/services/setup";

export async function setupOwner(_prev: SetupResult | null, form: FormData): Promise<SetupResult> {
  return createFirstOwnerInvite({
    email: String(form.get("email") ?? ""),
    name: String(form.get("name") ?? ""),
    secret: String(form.get("secret") ?? ""),
  });
}
