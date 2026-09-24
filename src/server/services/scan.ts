import "server-only";
import { env } from "../env";

export type ScanResult = "clean" | "infected" | "not_scanned";

export interface Scanner {
  /** False when no scanner is configured (files are recorded "not scanned" without extra work). */
  enabled: boolean;
  scan(input: { downloadUrl: string | null; name: string; contentType: string; size: number }): Promise<ScanResult>;
}

let override: Scanner | null = null;
export function setScannerForTests(s: Scanner | null) {
  override = s;
}

/**
 * Virus-scan hook. With VIRUS_SCAN_URL set, the scanner gets a JSON POST
 * `{ url, name, contentType, size }` (the url is a 5-minute signed link) and
 * must answer `{ "clean": true | false }`. Any error or timeout records the
 * file as not scanned rather than blocking work; an explicit `clean: false`
 * rejects the upload and deletes the bytes.
 */
export function scanner(): Scanner {
  if (override) return override;
  const url = env().VIRUS_SCAN_URL;
  if (!url) return { enabled: false, scan: async () => "not_scanned" };
  return {
    enabled: true,
    async scan(input) {
      if (!input.downloadUrl) return "not_scanned";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(env().VIRUS_SCAN_TOKEN ? { authorization: `Bearer ${env().VIRUS_SCAN_TOKEN}` } : {}) },
          body: JSON.stringify({ url: input.downloadUrl, name: input.name, contentType: input.contentType, size: input.size }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return "not_scanned";
        const body = (await res.json()) as { clean?: unknown };
        return body.clean === true ? "clean" : body.clean === false ? "infected" : "not_scanned";
      } catch {
        return "not_scanned";
      }
    },
  };
}
