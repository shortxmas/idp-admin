# idp-admin reference

One file per published entry point. This file covers the core, `idp-admin`: `IdpAdmin`, the types every adapter shares, the errors, and the adapter contract.

| Entry point | Doc |
|---|---|
| `idp-admin` | This file |
| `idp-admin/fake` | [fake.md](fake.md) |
| `idp-admin/cognito` | [cognito.md](cognito.md) |
| `idp-admin/keycloak` | [keycloak.md](keycloak.md) |

## `IdpAdmin`

What apps call. It wraps one adapter and adds the rules every provider shares.

```ts
import { IdpAdmin } from "idp-admin"
import { CognitoAdapter } from "idp-admin/cognito"

const admin = new IdpAdmin(new CognitoAdapter({ userPoolId, region: "us-east-1" }), {
    onAccessReduced: ({ userId }) => revokeAllSessionsFor(userId),
})
```

`TAttr`, the attribute names, comes from the adapter, so `admin.createUser` accepts exactly the attributes that adapter declares.

### Options

| Option | Default | Meaning |
|---|---|---|
| `onAccessReduced` | none | Called after a user is deleted, disabled or removed from a group, with an `AccessReducedEvent`. Use it to end the app's own sessions for that user. It may be sync or async. It can run more than once for the same change, so it must be safe to repeat. |

```ts
type AccessReducedEvent =
    | { userId: string; action: "deleted" | "disabled" }
    | { userId: string; action: "removed-from-group"; group: string }
```

### Shared rules

- **Emails** are trimmed and lowercased before they reach the adapter, in `createUser`, `createUserWithInvite` and `findUserByEmail`. `Dana@Example.com` and `dana@example.com` are the same user.
- **Taking access away** (`deleteUser`, `disableUser`, `removeFromGroup`) runs these steps in order:
  1. the change at the provider
  2. provider sign-out (`signOutEverywhere`), for `disableUser` and `removeFromGroup`. Deleting already ends the user's tokens at the provider, so `deleteUser` skips it
  3. `onAccessReduced`

  If step 2 or 3 fails, the method throws `AccessReductionIncompleteError` and the provider change stands. All three methods are safe to repeat and run every step each time, so calling the same method again is the recovery.
- **Provider sign-out revokes refresh tokens.** Access and ID tokens already issued stay valid until they expire (about an hour by default on Cognito). Ending the app's sessions in `onAccessReduced` is what takes effect immediately.
- **Lists** are async iterators over the adapter's pages. The next page is fetched only when the loop reaches it, and `break` stops fetching.
- **Optional features:** a method the adapter lacks throws `NotSupportedError`. `supports` tells you beforehand.

### Methods

| Method | Returns | Behaviour |
|---|---|---|
| `createUser({ email, name?, attributes?, temporaryPassword })` | `IdpUser` | The user must replace `temporaryPassword` at first sign-in. The provider sends no message, so send your own. Throws `UserExistsError`. |
| `createUserWithInvite({ email, name?, attributes? })` | `IdpUser` | The provider generates a password and emails its own invitation. Throws `UserExistsError`, or `NotSupportedError` if the adapter can't. |
| `getUser(userId)` | `IdpUser` | Throws `UserNotFoundError`. |
| `findUserByEmail(email)` | `IdpUser \| null` | `null` when nobody has that email. |
| `listUsers()` | `AsyncGenerator<IdpUser>` | Every user. |
| `setPassword(userId, password, { temporary })` | `void` | A temporary password must be replaced at next sign-in. |
| `updateAttributes(userId, attributes)` | `void` | Sets the given attributes and leaves the rest unchanged. |
| `resendInvite(userId)` | `void` | Sends the provider's invitation again. Throws `NotSupportedError` if the adapter can't. |
| `enableUser(userId)` | `void` | |
| `disableUser(userId)` | `void` | Then provider sign-out, then `onAccessReduced`. Succeeds if already disabled. |
| `deleteUser(userId)` | `boolean` | Then `onAccessReduced`. `true` if a user was deleted, `false` if they were already gone; the hook runs either way. |
| `signOutEverywhere(userId)` | `void` | Revokes the user's tokens at the provider. Doesn't call `onAccessReduced`. |
| `addToGroup(userId, group)` | `void` | Succeeds if they're already a member. Throws `GroupNotFoundError`. |
| `removeFromGroup(userId, group)` | `void` | Then provider sign-out, then `onAccessReduced`. Succeeds if they aren't a member or the group doesn't exist. |
| `listUserGroups(userId)` | `AsyncGenerator<string>` | The names of the groups a user is in. |
| `listGroupMembers(group)` | `AsyncGenerator<IdpUser>` | Throws `GroupNotFoundError`. |
| `ensureGroup(group)` | `void` | Creates the group, or does nothing if it exists, including when another caller creates it at the same moment. |
| `deleteGroup(group)` | `void` | Removes every member first. Doesn't call `onAccessReduced`; to end members' sessions, call `removeFromGroup` for each before deleting it. |

Unless a row says otherwise, a method addressing a missing user throws `UserNotFoundError`.

| Property | Meaning |
|---|---|
| `adapter` | The adapter passed in, for its `native` client and anything the shared methods don't cover. Calls made on it directly skip the shared rules. |
| `supports` | `{ createUserWithInvite: boolean; resendInvite: boolean }`: which optional features the adapter has. |

## Types

### `IdpUser<TAttr>`

```ts
type IdpUser<TAttr extends string = never> = {
    id: string
    email: string
    name: string | null
    status: UserStatus
    enabled: boolean
    attributes: UserAttributes<TAttr>
}
```

| Field | Meaning |
|---|---|
| `id` | The provider's permanent id for the user: the one their sign-in tokens carry as `sub`. Cognito: the user's `sub`. Keycloak: the user id. Fake: a UUID v4. |
| `email` | Always lowercase. |
| `name` | `null` when the provider has none. |
| `status` | Where they are in their account lifecycle. See `UserStatus`. |
| `enabled` | `false` once disabled. A disabled user can't sign in, whatever their `status`. |
| `attributes` | Custom attributes, keyed by the names declared in the adapter's config. |

### `UserStatus`

```ts
type UserStatus = "active" | "password_change_required" | "federated" | "unconfirmed"
```

| Value | Meaning |
|---|---|
| `active` | Has a permanent password, or otherwise needs nothing before signing in. |
| `password_change_required` | Has a temporary password and must set their own at next sign-in. |
| `federated` | Signs in through another identity provider (SSO), so has no password here. |
| `unconfirmed` | Signed themselves up and hasn't confirmed their account yet. |

Whether a user is disabled is `enabled`, not a status: a user disabled before setting a password is still `password_change_required`.

### `UserAttributes<TAttr>`

```ts
type UserAttributes<TAttr extends string> = [TAttr] extends [never] ? Record<string, never> : Partial<Record<TAttr, string>>
```

`TAttr` is the attribute names declared in the adapter's config, inferred from it; no type parameter is written by hand. Only declared names compile, and with none declared no attribute compiles. Values are strings, because that is what providers store.

### `Page<T>`

```ts
type Page<T> = { items: T[]; nextCursor: string | null }
```

One page of a list. Pass `nextCursor` back to get the next page; it is `null` on the last page. Cursors are opaque: don't build or change them.

## Errors

Every error idp-admin throws on purpose extends `IdpAdminError`, so `instanceof IdpAdminError` separates them from provider and network failures. Each has a fixed `code`, typed as a literal, and `name` set to its class name. `AnyIdpAdminError` is the union of all of them, so `switch(error.code)` narrows to the matching class.

| Class | `code` | Extra fields | Thrown when |
|---|---|---|---|
| `UserNotFoundError` | `USER_NOT_FOUND` | `userId` | The user doesn't exist, or no longer does. |
| `UserExistsError` | `USER_EXISTS` | `email` | Creating a user whose email is taken. |
| `GroupNotFoundError` | `GROUP_NOT_FOUND` | `group` | The group doesn't exist. |
| `GroupExistsError` | `GROUP_EXISTS` | `group` | Creating a group that exists. |
| `NotSupportedError` | `NOT_SUPPORTED` | `feature` | The adapter can't do what was asked; `feature` names the method or option. |
| `AccessReductionIncompleteError` | `ACCESS_REDUCTION_INCOMPLETE` | `userId`, `action`, `failedStep`, `cause` | A user was deleted, disabled or removed from a group at the provider, but a later step failed. |

`AccessReductionIncompleteError`:
- `action` is `"deleted"`, `"disabled"` or `"removed-from-group"`: what already happened at the provider. It is not undone.
- `failedStep` is `"provider-sign-out"` or `"hook"`: the step after it that failed.
- `cause` is the original error.
- Calling the same method again is safe and repeats every step.

## `IdpAdapter<TAttr>`

The contract every adapter implements: plain translation to one provider's admin API. Shared rules live in `IdpAdmin`, so an adapter can't get them wrong. Apps call `IdpAdmin`, not adapters; this section is for writing an adapter.

Every user is addressed by `userId`, the provider's permanent id. A method that addresses a user who doesn't exist throws `UserNotFoundError`; one that addresses a group that doesn't exist throws `GroupNotFoundError`. Emails passed in are already lowercased and trimmed.

| Method | Returns | Behaviour |
|---|---|---|
| `createUser(input)` | `IdpUser` | Creates a user with `input.temporaryPassword`, who must replace it at first sign-in. The provider sends no message. Throws `UserExistsError`. |
| `createUserWithInvite?(input)` | `IdpUser` | Optional. The provider generates a password and sends its own invitation. Throws `UserExistsError`. |
| `getUser(userId)` | `IdpUser` | |
| `findUserByEmail(email)` | `IdpUser \| null` | `null` when nobody has that email. |
| `listUsersPage(cursor)` | `Page<IdpUser>` | One page of every user. Pass `null` for the first page. |
| `setPassword(userId, password, { temporary })` | `void` | A temporary password must be replaced at next sign-in. |
| `setEnabled(userId, enabled)` | `void` | Succeeds if the user is already in that state. |
| `deleteUser(userId)` | `void` | Also removes them from every group. |
| `updateAttributes(userId, attributes)` | `void` | Sets the given attributes and leaves the rest unchanged. |
| `resendInvite?(userId)` | `void` | Optional. Sends the provider's invitation again. |
| `signOutEverywhere(userId)` | `void` | Revokes the user's tokens at the provider. |
| `addToGroup(userId, group)` | `void` | Succeeds if they're already a member. |
| `removeFromGroup(userId, group)` | `void` | Succeeds if they aren't a member. |
| `listUserGroupsPage(userId, cursor)` | `Page<string>` | One page of the names of the groups a user is in. |
| `groupExists(group)` | `boolean` | |
| `createGroup(group)` | `void` | Throws `GroupExistsError`. |
| `deleteGroup(group)` | `void` | Removes every member from it first. |
| `listGroupMembersPage(group, cursor)` | `Page<IdpUser>` | One page of a group's members. |

`AdapterCreateUserInput<TAttr>` is `{ email, name?, attributes?, temporaryPassword }`. `AdapterInviteUserInput<TAttr>` is the same without `temporaryPassword`.
