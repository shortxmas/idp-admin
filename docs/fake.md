# fake

`idp-admin/fake`: an identity provider that keeps users and groups in memory. [Index](index.md)

It's the reference implementation every other adapter is tested against, and a provider for tests that need no container or cloud account. It implements every method of [`IdpAdapter`](index.md#idpadaptertattr), including the optional ones, and adds a few helpers only a fake can offer.

Not for production: nothing is shared between instances or kept after the process exits.

## `new FakeAdapter(options?)`

```ts
import { FakeAdapter } from "idp-admin/fake"

const fake = new FakeAdapter({ attributes: ["company"] })
```

| Option | Default | Meaning |
|---|---|---|
| `attributes` | none | Custom attribute names users may have. They become the adapter's attribute type, so only these compile, and anything else is also rejected at runtime with a `TypeError`, as a real provider would. |
| `pageSize` | `60` | Most items per page from the list methods. `60` is Cognito's largest page; set it low to test paging. |

## Behaviour

- **Ids** are UUID v4s from `crypto.randomUUID()`.
- **Emails** are matched exactly. They arrive already lowercased (`IdpAdmin` normalises them), so the fake doesn't lowercase again.
- **Status:**
  - a user from `createUser` or `createUserWithInvite` starts as `password_change_required`
  - `setPassword` with `temporary: true` sets `password_change_required`, and with `temporary: false` sets `active`
  - a federated user stays `federated` whatever `setPassword` does, because they sign in elsewhere
- **Disabling** changes `enabled` only; the status is kept.
- **Lists** return items in creation order. A cursor is the offset of the next page's first item.
- **Copies:** every user returned is a copy, so changing it doesn't change the stored user.
- **Deleting** a user also frees their email and removes them from every group. Deleting a group removes it from its members.

## Fake-only helpers

### `addFederatedUser(input)`

```ts
const admin = fake.addFederatedUser({ email: "admin@mc3.co", name: "An Admin", attributes: { company: "MC3" } })
```

Adds a user who signs in through another identity provider (SSO), with status `federated`. A real provider creates these when someone first signs in through SSO, so only the fake can add one directly. Synchronous. Throws `UserExistsError` if the email is taken.

### `invitations`

```ts
fake.invitations   // readonly { userId: string; email: string }[]
```

Every provider invitation the fake would have sent, oldest first: one per `createUserWithInvite` and one per `resendInvite`. `createUser` sends none, because the app sends its own email.

### `signOuts`

```ts
fake.signOuts   // readonly string[]
```

The id of every user signed out at the provider, oldest first, once per `signOutEverywhere` call.
