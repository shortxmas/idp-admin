# Contributing to idp-admin

## Development

```sh
npm install
npm test            # jest
npm run typecheck   # tsc --noEmit
```

- **Test-driven:** write the test first and watch it fail, then implement.
- **Test layout:** one test file per source file, next to it. `fake/index.ts` has `fake/index.test.ts`. The exceptions are `src/adapters.test.ts` (see below) and `src/keycloak/test-realm.ts`, a helper the Keycloak tests share, which the build leaves out.
- **Adapter conformance:** `src/adapters.test.ts` runs the same scenarios against every adapter: creating duplicates, escaping, pagination, federated users, idempotent group changes and so on. A new adapter is added to the list in that file and must pass all of it. Behaviour every adapter shares gets its test there; anything specific to one provider goes in that adapter's own test file.
- **Provider tests:** adapters are tested against real providers, configured through `.env`. `jest.config.js` loads `.env`, and variables already set in the environment take precedence. A provider whose tests need a cloud account is skipped when its settings are missing; CI always sets them.
  - **Keycloak:** `npm test` needs Docker. `jest.global-setup.js` starts a throwaway Keycloak 26 container on a free port before the tests, and `jest.global-teardown.js` removes it afterwards, including when a run is interrupted. Each test creates its own realm and deletes it. The first run downloads the image. To skip the container start on repeated runs, run a Keycloak yourself and set `KEYCLOAK_TEST_URL` and its admin credentials (see `.env.example`).
- **CI:** `.github/workflows/ci.yml` runs the typecheck, the tests and the build on every pull request and every push to `main`, with the same throwaway Keycloak container `npm test` starts locally.
- **Docs:** one reference file per published entry point, in `docs/`. `src/index.ts` has `docs/index.md`, and `src/cognito/index.ts` has `docs/cognito.md`. They ship in the npm package, so update the matching doc in the same change as the code: every export, option, default, error and behaviour. `README.md` holds the concept, install, the quick start and guides, and links to the docs instead of repeating them.

## Adding a published entry point

Each subpath (`idp-admin/cognito`, …) is a folder in `src/` with an `index.ts`, an entry in the `exports` map in `package.json`, and a doc in `docs/`. `src/package-exports.test.ts` checks the `exports` map against `src/`, so it fails if an entry is missing or points at the wrong file.

Provider SDKs are optional peer dependencies (`peerDependenciesMeta`), imported only by their own adapter, so installing idp-admin for one provider never pulls in another provider's SDK.

## Releasing

Releases are published to npm from CI. Put `[major]`, `[minor]` or `[patch]` in a commit's **title** (its first line) and push it to `main`. When squash-merging, the PR title becomes the commit title. Tags in a commit's body are ignored, so a description can mention them safely. After the tests pass, the `release` job:

1. picks the bump from the titles of the pushed commits (the highest one wins if several are tagged; case doesn't matter)
2. runs `npm version <bump>` on the version in `package.json`
3. builds and runs `npm publish --provenance`
4. commits the new version to `main` as `Release vX.Y.Z [skip ci]`
5. creates a GitHub release `vX.Y.Z` on that commit, with notes generated from the changes since the last release. This step only runs if the npm publish succeeded.

Pushes without a tag run the tests and publish nothing. Don't edit `version` in `package.json` by hand.

Setup:
- **`NPM_TOKEN`:** a repository secret holding an npm token allowed to publish `idp-admin`, e.g. a granular token with read and write access to the package.
- **Branch protection:** if `main` is protected, it must allow GitHub Actions to push, or step 4 fails after the package is already published.

`npm run build` compiles `src/` (minus the tests) to `dist/` with `tsconfig.build.json`. The package ships `dist/`, `docs/`, the README and the license only.

## Source layout

| Path | Published as | Purpose |
|---|---|---|
| `src/index.ts` | `idp-admin` | Core: the shared interface, user and group types, errors, hooks |
| `src/cognito/` | `idp-admin/cognito` | Amazon Cognito adapter |
| `src/keycloak/` | `idp-admin/keycloak` | Keycloak adapter |
| `src/fake/` | `idp-admin/fake` | Fake adapter that keeps everything in memory: the reference implementation, and a provider for tests |
