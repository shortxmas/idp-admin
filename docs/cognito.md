# cognito

`idp-admin/cognito`: Amazon Cognito user pools, through the admin API of the AWS SDK. [Index](index.md)

`@aws-sdk/client-cognito-identity-provider` (v3) is an optional peer dependency: install it alongside idp-admin to use this adapter.

```sh
npm install idp-admin @aws-sdk/client-cognito-identity-provider
```

## `new CognitoAdapter(options)`

```ts
import { CognitoAdapter } from "idp-admin/cognito"

const adapter = new CognitoAdapter({
    userPoolId: process.env.COGNITO_USER_POOL_ID!,
    region: "us-east-1",
    attributes: { company: "custom:companyName" },
})
```

| Option | Default | Meaning |
|---|---|---|
| `userPoolId` | required | The user pool to manage. |
| `client` | none | A `CognitoIdentityProviderClient` you configured. When given, `region` and `credentials` are ignored. |
| `region` | none | The pool's region, to build a client with. Either `client` or `region` is required; with neither, the constructor throws a `TypeError`. |
| `credentials` | the AWS SDK's credential chain | Credentials for the built client. |
| `attributes` | none | App attribute name → Cognito attribute name, e.g. `{ company: "custom:companyName" }`. The app names become the adapter's attribute type, so only they compile, and any other name is rejected at runtime with a `TypeError`. Custom attributes must exist in the pool's schema. |
| `pageSize` | `60` | Most items per page from the list methods, a whole number from 1 to 60 (Cognito's largest page). Anything else throws a `RangeError`. |

## IAM permissions

The adapter calls these `cognito-idp` actions on the pool:

`AdminCreateUser`, `AdminGetUser`, `ListUsers`, `AdminSetUserPassword`, `AdminEnableUser`, `AdminDisableUser`, `AdminDeleteUser`, `AdminUpdateUserAttributes`, `AdminUserGlobalSignOut`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `ListUsersInGroup`, `GetGroup`, `CreateGroup`, `DeleteGroup`

Every one of them can be limited to the pool's ARN, `arn:aws:cognito-idp:<region>:<account>:userpool/<pool id>`.

## Behaviour

- **Ids** are the user's `sub`, which their tokens carry. A local user's `sub` is also their Cognito username, so admin calls use it directly. An SSO user's username is provider-qualified (`MicrosoftEntraIDSAML_…`), and Cognito won't take their `sub`: the first call for one looks their username up by `sub` and the adapter remembers it. Lists remember the usernames they see, too.
- **Emails** are the username, and are stored as verified, because an admin typed them in. Cognito matches them case-insensitively and rejects emails it considers invalid, including ones containing `"`. `findUserByEmail` returns `null` for an email containing `"` without asking Cognito, because Cognito's filter syntax has no way to escape one.
- **Names** are stored in Cognito's standard `name` attribute.
- **Status:**

  | Cognito `UserStatus` | `status` |
  |---|---|
  | `CONFIRMED` | `active` |
  | `FORCE_CHANGE_PASSWORD`, `RESET_REQUIRED`, `COMPROMISED` | `password_change_required` |
  | `UNCONFIRMED` | `unconfirmed` |
  | `EXTERNAL_PROVIDER` | `federated` |
  | anything else | `active` |

- **Attributes** are single Cognito attributes under their Cognito names. `updateAttributes` changes only the ones given.
- **Invitations:** `createUser` sends nothing, because the app sends its own email with the temporary password. `createUserWithInvite` has Cognito generate a password and email its invitation, and `resendInvite` sends it again. Both use the pool's email settings; Cognito's default sender has a low daily limit.
- **Groups** are addressed by name. Cognito removes a user from a group that doesn't exist without complaint, so `removeFromGroup` checks the group first and throws `GroupNotFoundError`.
- **Sign-out:** `signOutEverywhere` revokes the user's refresh tokens. Access and ID tokens already issued stay valid until they expire, about an hour by default.
- **Lists** use Cognito's own page tokens as cursors. Cognito doesn't return users in creation order.

## Errors

Cognito's `UsernameExistsException` and `AliasExistsException` become `UserExistsError`, `UserNotFoundException` becomes `UserNotFoundError`, `ResourceNotFoundException` on a group becomes `GroupNotFoundError`, and `GroupExistsException` becomes `GroupExistsError`. Every other Cognito error, such as `TooManyRequestsException`, is thrown unchanged. An unknown attribute name throws a `TypeError` before anything is sent.

## `native`

```ts
adapter.native.client       // the CognitoIdentityProviderClient
adapter.native.userPoolId
```

The client and pool, for anything the shared interface doesn't cover.
