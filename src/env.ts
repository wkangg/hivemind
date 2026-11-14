// Bun reads .env on its own. Node doesn't, so entry points import this first.
// Variables that are already set are left alone.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
