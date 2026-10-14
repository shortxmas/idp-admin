import type { IdpUser, Page, UserAttributes } from "./types"

/** What `createUser` passes an adapter. The email is already lowercased and trimmed. */
export type AdapterCreateUserInput<TAttr extends string = never> = {
    email: string
    name?: string
    attributes?: UserAttributes<TAttr>
    // the user must replace it at first sign-in; the provider sends no message of its own
    temporaryPassword: string
}

/** What `createUser` passes an adapter when the provider should generate a password and send its own invitation. */
export type AdapterInviteUserInput<TAttr extends string = never> = Omit<AdapterCreateUserInput<TAttr>, "temporaryPassword">

/**
 * The contract every adapter implements: plain translation to one provider's admin API. Shared rules
 * (normalising emails, the access-reduced hook, provider sign-out, paging, idempotent removal) live in
 * `IdpAdmin`, not here, so an adapter can't get them wrong.
 *
 * Every user is addressed by `userId`, the provider's permanent id that sign-in tokens carry as `sub`.
 * Methods that address a user who doesn't exist throw `UserNotFoundError`; methods that address a
 * group that doesn't exist throw `GroupNotFoundError`. Methods marked optional are features some
 * providers lack; `IdpAdmin` throws `NotSupportedError` when one is missing.
 */
export interface IdpAdapter<TAttr extends string = never>{
    /** @throws {UserExistsError} a user with this email exists */
    createUser(input: AdapterCreateUserInput<TAttr>): Promise<IdpUser<TAttr>>

    /** Optional. @throws {UserExistsError} a user with this email exists */
    createUserWithInvite?(input: AdapterInviteUserInput<TAttr>): Promise<IdpUser<TAttr>>

    /** @throws {UserNotFoundError} */
    getUser(userId: string): Promise<IdpUser<TAttr>>

    /** The user with exactly this email (already lowercased), or null. */
    findUserByEmail(email: string): Promise<IdpUser<TAttr> | null>

    /** One page of every user; pass null for the first page. */
    listUsersPage(cursor: string | null): Promise<Page<IdpUser<TAttr>>>

    /** A temporary password must be replaced at next sign-in. @throws {UserNotFoundError} */
    setPassword(userId: string, password: string, options: { temporary: boolean }): Promise<void>

    /** Succeeds if the user is already in that state. @throws {UserNotFoundError} */
    setEnabled(userId: string, enabled: boolean): Promise<void>

    /** Also removes them from every group. @throws {UserNotFoundError} */
    deleteUser(userId: string): Promise<void>

    /** Sets the given attributes and leaves the rest unchanged. @throws {UserNotFoundError} */
    updateAttributes(userId: string, attributes: UserAttributes<TAttr>): Promise<void>

    /** Optional. Sends the provider's invitation again. @throws {UserNotFoundError} */
    resendInvite?(userId: string): Promise<void>

    /** Revokes the user's tokens at the provider. @throws {UserNotFoundError} */
    signOutEverywhere(userId: string): Promise<void>

    /** Succeeds if they're already a member. @throws {UserNotFoundError} @throws {GroupNotFoundError} */
    addToGroup(userId: string, group: string): Promise<void>

    /** Succeeds if they aren't a member. @throws {UserNotFoundError} @throws {GroupNotFoundError} */
    removeFromGroup(userId: string, group: string): Promise<void>

    /** One page of the names of the groups a user is in. @throws {UserNotFoundError} */
    listUserGroupsPage(userId: string, cursor: string | null): Promise<Page<string>>

    groupExists(group: string): Promise<boolean>

    /** @throws {GroupExistsError} */
    createGroup(group: string): Promise<void>

    /** Removes every member from it first. @throws {GroupNotFoundError} */
    deleteGroup(group: string): Promise<void>

    /** One page of a group's members. @throws {GroupNotFoundError} */
    listGroupMembersPage(group: string, cursor: string | null): Promise<Page<IdpUser<TAttr>>>
}
