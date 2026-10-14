# idp-admin

One user-management API for any identity provider.

Apps that sign people in through an identity provider (Cognito, Keycloak, Entra ID, Auth0, Okta and the like) usually also need to manage those people from inside the app: invite someone, put them in a group, disable them, remove them. Every provider has its own admin SDK for this, and every app ends up writing its own layer on top of it.

idp-admin is that layer, written once.

> **Status:** 0.x, so the API may still change between minor versions. See the [quick start](#quick-start) and the [reference](docs/index.md).

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

## Quick start

```sh
npm install idp-admin
npm install @aws-sdk/client-cognito-identity-provider   # only for Cognito
```

Wrap the adapter for your provider in `IdpAdmin`. Each adapter's setup (credentials, permissions, realm or pool settings) is in its doc: [Cognito](docs/cognito.md), [Keycloak](docs/keycloak.md), [fake](docs/fake.md).

```ts
import { IdpAdmin } from "idp-admin"
import { CognitoAdapter } from "idp-admin/cognito"
import { KeycloakAdapter } from "idp-admin/keycloak"

// Cognito in production, Keycloak in a container locally: the rest of the app doesn't know which
const adapter = process.env.COGNITO_USER_POOL_ID
    ? new CognitoAdapter({
        userPoolId: process.env.COGNITO_USER_POOL_ID,
        region: "us-east-1",
        attributes: { company: "custom:companyName" },
    })
    : new KeycloakAdapter({
        issuer: "http://localhost:8080/realms/acme",
        clientId: "acme-admin",
        clientSecret: process.env.KEYCLOAK_ADMIN_SECRET!,
        attributes: { company: "companyName" },
    })

const admin = new IdpAdmin(adapter, {
    // runs whenever someone loses access, so their sessions in your app end too
    onAccessReduced: ({ userId }) => revokeAllSessionsFor(userId),
})
```

`attributes` maps the names your app uses to the provider's own, and only those names compile.

```ts
import { UserExistsError, generateTemporaryPassword } from "idp-admin"

// create a user who must set their own password at first sign-in; send them the temporary one yourself
try{
    const user = await admin.createUser({
        email: "Dana@Example.com",   // stored and matched as dana@example.com
        name: "Dana Lee",
        attributes: { company: "Acme" },
        temporaryPassword: generateTemporaryPassword(),
    })
    await admin.ensureGroup("admins")
    await admin.addToGroup(user.id, "admins")
}catch(error){
    if(error instanceof UserExistsError) console.log("already invited")
    else throw error
}

// take access away: disabled at the provider, signed out there, then onAccessReduced
const dana = await admin.findUserByEmail("dana@example.com")
if(dana) await admin.disableUser(dana.id)

// everyone, fetched a page at a time behind the scenes
for await (const user of admin.listUsers()) console.log(user.email, user.status, user.enabled)
```

A user's `id` is the `sub` in their sign-in tokens, so it matches what your auth library gives you, and it's what `onAccessReduced` receives. `findUserByEmail` returns `null` while `getUser` throws `UserNotFoundError`. If ending sessions fails after the provider change, the method throws `AccessReductionIncompleteError`, and calling it again is safe. The full list of methods, types and errors is in [docs/index.md](docs/index.md).

In tests, use the fake instead. It keeps everything in memory and records what a real provider would have done:

```ts
import { FakeAdapter } from "idp-admin/fake"

const fake = new FakeAdapter({ attributes: ["company"] })
const admin = new IdpAdmin(fake, { onAccessReduced })
// ...run the code under test with `admin`, then:
expect(fake.signOuts).toContain(userId)
```

## Providers

Cognito, Keycloak and the fake provider are included today: the ones we run in production and can test properly.

The interface is designed so that other providers (Entra ID, Auth0, Okta, Zitadel, Authentik and more) can be added through the same contract. Each one is contributed here and must pass the shared test suite.

## License

MIT
