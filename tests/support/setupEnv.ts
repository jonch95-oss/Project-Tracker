// Environment for integration tests (runs before each test file).
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.APP_URL = "http://localhost:3000";
process.env.CRON_SECRET = "test-job-secret-0123456789abcdef";
delete process.env.RESEND_API_KEY;

// Never call the real geocoder or Blob from tests: a stub puts every address in Brooklyn.
import { setGeocoderForTests } from "@/server/geo";
import { setStorageForTests } from "@/server/storage";
import { memoryStorage } from "@/server/storage/memory";

setGeocoderForTests({
  name: "stub",
  async geocode(address) {
    if (/nowhere/i.test(address)) return null;
    const n = [...address].reduce((a, c) => a + c.charCodeAt(0), 0) % 1000;
    return { latitude: 40.67 + n / 100_000, longitude: -73.97 + n / 100_000, bbl: /with bbl/i.test(address) ? "3011370045" : null, label: address };
  },
});
setStorageForTests(memoryStorage());
