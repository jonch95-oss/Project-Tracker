/** One password rule for every flow: invite, reset and change. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const PASSWORD_HINT = "At least 12 characters, mixing letters with numbers or symbols. A short sentence works well.";

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!/[a-zA-Z]/.test(password) || !/[^a-zA-Z]/.test(password)) return "Mix letters with numbers or symbols.";
  return null;
}
