# idp-admin

One user-management API for any identity provider.

Apps that sign people in through an identity provider (Cognito, Keycloak, Entra ID, Auth0, Okta and the like) usually also need to manage those people from inside the app: invite someone, put them in a group, disable them, remove them. Every provider has its own admin SDK for this, and every app ends up writing its own layer on top of it.

idp-admin is that layer, written once.

> **Status:** 0.x, so the API may still change between minor versions. The adapters are published and usable directly; `IdpAdmin`, the class that adds the shared rules on top of them (including the access-reduced hook below), isn't built yet.

```sh
npm install idp-admin
```

The reference for every entry point is in [docs](docs/index.md).

## Why it exists

**Every provider speaks a different language.** Method names, user statuses, error types, pagination and even what counts as a user's ID differ from one provider to the next. Code written against one doesn't carry over to another.

**Many apps run more than one provider.** A common setup is a managed provider in production and a self-hosted one in a container for local development and CI. That means writing the admin layer twice, and the two copies drift apart. A duplicate-user error gets handled locally but not in production. An email gets escaped before a lookup in one copy and not the other. A status one provider reports, the other never does. The app behaves differently depending on where it runs, which is exactly what a local environment is supposed to prevent.

**Taking access away doesn't end sessions on its own.** When someone is disabled, deleted or removed from a group, any session the app has already issued keeps working until it expires, unless every piece of admin code remembers to end it.

**Testing needs a real provider.** Without an abstraction, testing user-admin code means running a provider in a container or calling a cloud account.

This package came out of exactly that situation: two production apps, each with its own copy of the same admin layer for the same two providers, and security fixes being copied between them by hand.

## What it is

- **One interface** for everyday user administration: creating, finding, enabling and disabling, and deleting users, managing groups and group membership, and listing users.
- **An adapter for each provider**, all behaving the same way: the same user statuses, the same errors, the same notion of who a user is (the ID from their sign-in token), and the same safe handling of input and pagination.
- **A single place to react when access is reduced**, so the app can end that person's sessions every time, whichever code path made the change.
- **A fake provider** that keeps everything in memory, for fast tests with no containers or cloud accounts.
- **A shared test suite** that every adapter must pass. It defines what "behaves the same" means, so a new adapter can be trusted when the suite passes.

## What it isn't

- **Not sign-in.** Logging people in, sessions and tokens are out of scope. It works alongside whatever auth library you use.
- **Not a sync tool.** It doesn't copy users into your database. The identity provider stays the source of truth.
- **Not a lowest common denominator.** Providers differ, and some features don't exist everywhere. Adapters declare what they support, and you can always reach the provider's own SDK for anything the shared interface doesn't cover.
- **Not a UI.** It's the server-side layer an admin screen, a background job or a seed script would call.

## Providers

Cognito, Keycloak and the fake provider are included today: the ones we run in production and can test properly.

The interface is designed so that other providers (Entra ID, Auth0, Okta, Zitadel, Authentik and more) can be added through the same contract. Each one is contributed here and must pass the shared test suite.

## License

MIT
