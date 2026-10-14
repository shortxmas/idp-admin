// Load .env here, before Jest starts its workers, so they inherit any provider settings it sets.
// Variables already set in the environment win. Without settings, jest.global-setup.js starts a
// throwaway Keycloak for the run and jest.global-teardown.js removes it.
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  globalSetup: "./jest.global-setup.js",
  globalTeardown: "./jest.global-teardown.js",
  transform: {
    "^.+\\.ts$": ["@swc/jest"],
  },
};
