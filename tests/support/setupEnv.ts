// Environment for integration tests (runs before each test file).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.APP_URL = "http://localhost:3000";
process.env.JOB_SECRET = "test-job-secret-0123456789abcdef";
delete process.env.RESEND_API_KEY;
