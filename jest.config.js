// Load .env here, before Jest starts its workers, so they inherit the provider settings the integration
// tests read. Variables already set in the environment win. CI has no .env and sets them directly.
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["@swc/jest"],
  },
};
