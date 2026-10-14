# keycloak

`idp-admin/keycloak`: Keycloak, through its admin REST API. [Index](index.md)

Tested against Keycloak 26. It uses the global `fetch` and has no dependencies.

## `new KeycloakAdapter(options)`

```ts
import { KeycloakAdapter } from "idp-admin/keycloak"

const adapter = new KeycloakAdapter({
    issuer: "https://auth.example.com/realms/frcs",
    clientId: "frcs-admin",
    clientSecret: process.env.KEYCLOAK_ADMIN_SECRET!,
    attributes: { company: "companyName" },
})
```

| Option | Default | Meaning |
|---|---|---|
| `issuer` | required | The realm's URL, `<host>/realms/<realm>`: the same value the app uses as its OIDC issuer. A trailing slash is fine. Anything else throws a `TypeError`. |
| `clientId`, `clientSecret` | required | A confidential client whose service account the adapter acts as. See [Realm setup](#realm-setup). |
| `attributes` | none | App attribute name → Keycloak attribute name. The app names become the adapter's attribute type, so only they compile, and any other name is rejected at runtime with a `TypeError`. |
| `pageSize` | `50` | Most items per page from the list methods, a whole number from 1 to 99. Anything else throws a `RangeError`. |

## Realm setup

The adapter needs three things from the realm:

1. **A confidential client with a service account.** Client authentication on, Service account roles on. Nothing else about the client matters to the adapter.
2. **These realm-management roles on the service account,** exported as `KEYCLOAK_ADMIN_ROLES`: `manage-users`, `view-users`, `query-users`, `query-groups`, and `manage-realm` (for creating and deleting groups). The tests run with exactly these. If a call is refused, the error names them.
3. **Somewhere for custom attributes to go,** if `attributes` is set. Keycloak's user profile **silently drops** an attribute it doesn't declare unless unmanaged attributes are enabled. Either declare each Keycloak attribute name in Realm settings → User profile, or set Unmanaged attributes to Enabled. Before writing attributes, the adapter reads the realm's user profile and throws, without creating or changing anyone, if Keycloak would drop one.

Also worth knowing: by default Keycloak requires a first and last name before anyone can sign in ("Account is not fully set up"). A user created without a name, or with a one-word name, can't sign in until the realm's user profile makes those fields optional or the user fills them in.

## Behaviour

- **Ids** are Keycloak user ids, which Keycloak puts in the `sub` of the user's tokens.
- **Emails** are the username too. Keycloak stores them lowercase and rejects emails it considers invalid, including ones containing `"`. `findUserByEmail` matches exactly.
- **Names:** Keycloak keeps a first and a last name. The first word of `name` becomes the first name and the rest the last name. Reading joins them back with a space.
- **Status:**
  - `federated`: the user is linked to an identity provider (they signed in through SSO). This takes precedence over everything else.
  - `password_change_required`: the user has Keycloak's `UPDATE_PASSWORD` required action, which a temporary password sets.
  - `unconfirmed`: the user has the `VERIFY_EMAIL` required action.
  - `active`: anything else.
- **Attributes** are stored as single-value Keycloak attributes under their Keycloak names. `updateAttributes` keeps every attribute the app didn't declare, including ones set by other apps.
- **Groups** are top-level realm groups, addressed by exact name. Subgroups aren't supported.
- **Sign-out:** `signOutEverywhere` ends every session the user has, so their refresh tokens stop working. Access tokens already issued stay valid until they expire.
- **Not supported:** `createUserWithInvite` and `resendInvite`. Keycloak can only send invitations through required-action emails, which need SMTP on the realm. Send your own email with a temporary password instead.
- **Lists** ask Keycloak for one item more than a page, so the last page is known without an extra request. Detecting federated users takes one extra request per user listed.
- **Tokens:** the adapter gets a client-credentials token and reuses it until 30 seconds before it expires. Concurrent calls share one token request.

## Errors

Besides the idp-admin errors in the [index](index.md#errors):

| Error | When |
|---|---|
| `KeycloakRequestError` | Keycloak answered with a status the adapter doesn't turn into an idp-admin error. It has `method`, `path` and `status`. A rejected client secret and a refused call (403) both explain what to fix. |
| `TypeError` | An unknown attribute name, or an issuer that isn't `<host>/realms/<realm>`. |
| `Error` | The realm would silently drop an attribute. See [Realm setup](#realm-setup). |

## `native`

```ts
const response = await adapter.native.request("GET", "/users/count")
adapter.native.adminUrl   // https://auth.example.com/admin/realms/frcs
```

The admin API, authenticated as the service account, for anything the shared interface doesn't cover. Paths are relative to `/admin/realms/<realm>`. `request` returns the raw `Response` and doesn't throw on error statuses.
