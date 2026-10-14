import type { AdapterCreateUserInput, AdapterInviteUserInput, IdpAdapter } from "./adapter"
import {
    AccessReductionIncompleteError,
    GroupExistsError,
    GroupNotFoundError,
    NotSupportedError,
    UserNotFoundError,
    type AccessReductionAction,
} from "./errors"
import type { IdpUser, Page, UserAttributes } from "./types"

/** What the access-reduced hook is told: whose access was reduced, and how. */
export type AccessReducedEvent =
    | { userId: string; action: Exclude<AccessReductionAction, "removed-from-group"> }
    | { userId: string; action: "removed-from-group"; group: string }

export type IdpAdminOptions = {
    // runs after a user is deleted, disabled or removed from a group, to end the app's own sessions for
    // them; it may run more than once for the same change, so it must be safe to repeat
    onAccessReduced?: (event: AccessReducedEvent) => void | Promise<void>
}

/** The optional adapter methods, and whether the adapter in use has each. */
export type IdpAdminSupports = {
    createUserWithInvite: boolean
    resendInvite: boolean
}

/**
 * What apps call to manage users in their identity provider, through one adapter. Holds the rules every
 * provider shares: emails are lowercased and trimmed, and taking access away (deleting, disabling,
 * removing from a group) always ends the user's sessions, by signing them out at the provider and
 * calling `onAccessReduced`.
 */
export class IdpAdmin<TAttr extends string = never>{
    readonly #onAccessReduced: IdpAdminOptions["onAccessReduced"]

    /** The adapter, for its `native` client and anything the shared methods don't cover. */
    readonly adapter: IdpAdapter<TAttr>

    constructor(adapter: IdpAdapter<TAttr>, options: IdpAdminOptions = {}){
        this.adapter = adapter
        this.#onAccessReduced = options.onAccessReduced
    }

    get supports(): IdpAdminSupports{
        return {
            createUserWithInvite: typeof this.adapter.createUserWithInvite === "function",
            resendInvite: typeof this.adapter.resendInvite === "function",
        }
    }

    // ---- users

    /** Creates a user who must replace `temporaryPassword` at first sign-in. The provider sends no message. @throws {UserExistsError} */
    createUser(input: AdapterCreateUserInput<TAttr>): Promise<IdpUser<TAttr>>{
        return this.adapter.createUser({ ...input, email: normalizeEmail(input.email) })
    }

    /** Creates a user the provider generates a password for and sends its own invitation. @throws {UserExistsError} @throws {NotSupportedError} */
    async createUserWithInvite(input: AdapterInviteUserInput<TAttr>): Promise<IdpUser<TAttr>>{
        if(!this.adapter.createUserWithInvite) throw new NotSupportedError("createUserWithInvite")
        return this.adapter.createUserWithInvite({ ...input, email: normalizeEmail(input.email) })
    }

    /** @throws {UserNotFoundError} */
    getUser(userId: string): Promise<IdpUser<TAttr>>{
        return this.adapter.getUser(userId)
    }

    /** The user with this email, whatever its case, or null. */
    findUserByEmail(email: string): Promise<IdpUser<TAttr> | null>{
        return this.adapter.findUserByEmail(normalizeEmail(email))
    }

    /** Every user, fetched a page at a time as the loop needs them. */
    listUsers(): AsyncGenerator<IdpUser<TAttr>>{
        return all((cursor) => this.adapter.listUsersPage(cursor))
    }

    /** A temporary password must be replaced at next sign-in. @throws {UserNotFoundError} */
    setPassword(userId: string, password: string, options: { temporary: boolean }): Promise<void>{
        return this.adapter.setPassword(userId, password, options)
    }

    /** Sets the given attributes and leaves the rest unchanged. @throws {UserNotFoundError} */
    updateAttributes(userId: string, attributes: UserAttributes<TAttr>): Promise<void>{
        return this.adapter.updateAttributes(userId, attributes)
    }

    /** Sends the provider's invitation again. @throws {UserNotFoundError} @throws {NotSupportedError} */
    async resendInvite(userId: string): Promise<void>{
        if(!this.adapter.resendInvite) throw new NotSupportedError("resendInvite")
        await this.adapter.resendInvite(userId)
    }

    /** Revokes the user's tokens at the provider. Doesn't call `onAccessReduced`. @throws {UserNotFoundError} */
    signOutEverywhere(userId: string): Promise<void>{
        return this.adapter.signOutEverywhere(userId)
    }

    async enableUser(userId: string): Promise<void>{
        await this.adapter.setEnabled(userId, true)
    }

    /**
     * Disables the user, signs them out at the provider, then calls `onAccessReduced`. Succeeds for a user
     * who is already disabled, and repeats every step.
     * @throws {UserNotFoundError} @throws {AccessReductionIncompleteError} the user is disabled, but a later step failed
     */
    async disableUser(userId: string): Promise<void>{
        await this.adapter.setEnabled(userId, false)
        await this.#signOut(userId, "disabled")
        await this.#accessReduced({ userId, action: "disabled" })
    }

    /**
     * Deletes the user, then calls `onAccessReduced`, also when the user was already gone. Deleting ends
     * their tokens at the provider, so there is no separate sign-out. True if a user was deleted, false
     * if there was none.
     * @throws {AccessReductionIncompleteError} the user is deleted, but the hook failed
     */
    async deleteUser(userId: string): Promise<boolean>{
        let deleted = true
        try{
            await this.adapter.deleteUser(userId)
        }catch(error){
            if(!(error instanceof UserNotFoundError)) throw error
            deleted = false
        }
        await this.#accessReduced({ userId, action: "deleted" })
        return deleted
    }

    // ---- groups

    /** Succeeds if they're already a member. @throws {UserNotFoundError} @throws {GroupNotFoundError} */
    addToGroup(userId: string, group: string): Promise<void>{
        return this.adapter.addToGroup(userId, group)
    }

    /**
     * Removes the user from the group, signs them out at the provider, then calls `onAccessReduced`.
     * Succeeds if they aren't a member, or the group doesn't exist, and repeats every step.
     * @throws {UserNotFoundError} @throws {AccessReductionIncompleteError} the user is removed, but a later step failed
     */
    async removeFromGroup(userId: string, group: string): Promise<void>{
        try{
            await this.adapter.removeFromGroup(userId, group)
        }catch(error){
            if(!(error instanceof GroupNotFoundError)) throw error
            // nobody is in a group that doesn't exist, but the user must still exist
            await this.adapter.getUser(userId)
        }
        await this.#signOut(userId, "removed-from-group")
        await this.#accessReduced({ userId, action: "removed-from-group", group })
    }

    /** The names of every group the user is in. @throws {UserNotFoundError} */
    listUserGroups(userId: string): AsyncGenerator<string>{
        return all((cursor) => this.adapter.listUserGroupsPage(userId, cursor))
    }

    /** Every member of the group. @throws {GroupNotFoundError} */
    listGroupMembers(group: string): AsyncGenerator<IdpUser<TAttr>>{
        return all((cursor) => this.adapter.listGroupMembersPage(group, cursor))
    }

    /** Creates the group, or does nothing if it exists. */
    async ensureGroup(group: string): Promise<void>{
        if(await this.adapter.groupExists(group)) return
        try{
            await this.adapter.createGroup(group)
        }catch(error){
            // created by someone else since the check
            if(!(error instanceof GroupExistsError)) throw error
        }
    }

    /** Deletes the group, removing every member from it first. @throws {GroupNotFoundError} */
    deleteGroup(group: string): Promise<void>{
        return this.adapter.deleteGroup(group)
    }

    // ---- access reduction

    async #signOut(userId: string, action: AccessReductionAction): Promise<void>{
        try{
            await this.adapter.signOutEverywhere(userId)
        }catch(cause){
            throw new AccessReductionIncompleteError({ userId, action, failedStep: "provider-sign-out", cause })
        }
    }

    async #accessReduced(event: AccessReducedEvent): Promise<void>{
        try{
            await this.#onAccessReduced?.(event)
        }catch(cause){
            throw new AccessReductionIncompleteError({ userId: event.userId, action: event.action, failedStep: "hook", cause })
        }
    }
}

function normalizeEmail(email: string): string{
    return email.trim().toLowerCase()
}

async function* all<T>(page: (cursor: string | null) => Promise<Page<T>>): AsyncGenerator<T>{
    let cursor: string | null = null
    do{
        const result: Page<T> = await page(cursor)
        yield* result.items
        cursor = result.nextCursor
    }while(cursor !== null)
}
