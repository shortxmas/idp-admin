import { randomUUID } from "node:crypto"
import type { AdapterCreateUserInput, AdapterInviteUserInput, IdpAdapter } from "../adapter"
import { GroupExistsError, GroupNotFoundError, UserExistsError, UserNotFoundError } from "../errors"
import type { IdpUser, Page, UserAttributes, UserStatus } from "../types"

export type FakeAdapterOptions<TAttr extends string> = {
    // custom attribute names users may have; anything else is rejected, as a real provider would
    attributes?: readonly TAttr[]
    // most items per page from the list methods; defaults to 60, Cognito's largest page
    pageSize?: number
}

/** A provider invitation the fake would have sent. */
export type FakeInvitation = { userId: string; email: string }

/**
 * An identity provider that keeps users and groups in memory: the reference implementation every
 * other adapter is tested against, and a provider for tests that need no container or cloud account.
 * Ids are UUID v4s. Nothing is shared between instances or kept after the process exits.
 */
export class FakeAdapter<const TAttr extends string = never> implements IdpAdapter<TAttr>{
    readonly #attributeNames: ReadonlySet<string>
    readonly #pageSize: number
    // insertion order is creation order, which is the order the list methods return
    readonly #users = new Map<string, IdpUser<TAttr>>()
    readonly #idsByEmail = new Map<string, string>()
    readonly #groups = new Map<string, Set<string>>()
    readonly #invitations: FakeInvitation[] = []
    readonly #signOuts: string[] = []

    constructor(options: FakeAdapterOptions<TAttr> = {}){
        this.#attributeNames = new Set(options.attributes ?? [])
        this.#pageSize = options.pageSize ?? 60
    }

    /** Every provider invitation sent so far, oldest first: from `createUserWithInvite` and `resendInvite`. */
    get invitations(): readonly FakeInvitation[]{
        return this.#invitations.map((invitation) => ({ ...invitation }))
    }

    /** The id of every user signed out at the provider so far, oldest first, once per call. */
    get signOuts(): readonly string[]{
        return [...this.#signOuts]
    }

    /** Adds a user who signs in through another identity provider (SSO). Only the fake can do this directly. */
    addFederatedUser(input: { email: string; name?: string; attributes?: UserAttributes<TAttr> }): IdpUser<TAttr>{
        return copy(this.#add(input, "federated"))
    }

    async createUser(input: AdapterCreateUserInput<TAttr>): Promise<IdpUser<TAttr>>{
        return copy(this.#add(input, "password_change_required"))
    }

    async createUserWithInvite(input: AdapterInviteUserInput<TAttr>): Promise<IdpUser<TAttr>>{
        const user = this.#add(input, "password_change_required")
        this.#invitations.push({ userId: user.id, email: user.email })
        return copy(user)
    }

    async getUser(userId: string): Promise<IdpUser<TAttr>>{
        return copy(this.#user(userId))
    }

    async findUserByEmail(email: string): Promise<IdpUser<TAttr> | null>{
        const id = this.#idsByEmail.get(email)
        return id === undefined ? null : copy(this.#user(id))
    }

    async listUsersPage(cursor: string | null): Promise<Page<IdpUser<TAttr>>>{
        return this.#page([...this.#users.values()].map(copy), cursor)
    }

    async setPassword(userId: string, _password: string, options: { temporary: boolean }): Promise<void>{
        const user = this.#user(userId)
        // an SSO user signs in elsewhere, so a password here doesn't change how they sign in
        if(user.status !== "federated") user.status = options.temporary ? "password_change_required" : "active"
    }

    async setEnabled(userId: string, enabled: boolean): Promise<void>{
        this.#user(userId).enabled = enabled
    }

    async deleteUser(userId: string): Promise<void>{
        const user = this.#user(userId)
        for(const members of this.#groups.values()) members.delete(userId)
        this.#idsByEmail.delete(user.email)
        this.#users.delete(userId)
    }

    async updateAttributes(userId: string, attributes: UserAttributes<TAttr>): Promise<void>{
        const user = this.#user(userId)
        this.#checkAttributes(attributes)
        Object.assign(user.attributes, attributes)
    }

    async resendInvite(userId: string): Promise<void>{
        const user = this.#user(userId)
        this.#invitations.push({ userId, email: user.email })
    }

    async signOutEverywhere(userId: string): Promise<void>{
        this.#user(userId)
        this.#signOuts.push(userId)
    }

    async addToGroup(userId: string, group: string): Promise<void>{
        this.#user(userId)
        this.#group(group).add(userId)
    }

    async removeFromGroup(userId: string, group: string): Promise<void>{
        this.#user(userId)
        this.#group(group).delete(userId)
    }

    async listUserGroupsPage(userId: string, cursor: string | null): Promise<Page<string>>{
        this.#user(userId)
        const names = [...this.#groups].filter(([, members]) => members.has(userId)).map(([name]) => name)
        return this.#page(names, cursor)
    }

    async groupExists(group: string): Promise<boolean>{
        return this.#groups.has(group)
    }

    async createGroup(group: string): Promise<void>{
        if(this.#groups.has(group)) throw new GroupExistsError(group)
        this.#groups.set(group, new Set())
    }

    async deleteGroup(group: string): Promise<void>{
        this.#group(group)
        this.#groups.delete(group)
    }

    async listGroupMembersPage(group: string, cursor: string | null): Promise<Page<IdpUser<TAttr>>>{
        const members = [...this.#group(group)].map((id) => copy(this.#user(id)))
        return this.#page(members, cursor)
    }

    #add(input: { email: string; name?: string; attributes?: UserAttributes<TAttr> }, status: UserStatus): IdpUser<TAttr>{
        if(this.#idsByEmail.has(input.email)) throw new UserExistsError(input.email)
        this.#checkAttributes(input.attributes ?? {})
        const user: IdpUser<TAttr> = {
            id: randomUUID(),
            email: input.email,
            name: input.name ?? null,
            status,
            enabled: true,
            attributes: { ...input.attributes },
        }
        this.#users.set(user.id, user)
        this.#idsByEmail.set(user.email, user.id)
        return user
    }

    // The stored user, for reading or changing in place; callers get copies.
    #user(userId: string): IdpUser<TAttr>{
        const user = this.#users.get(userId)
        if(!user) throw new UserNotFoundError(userId)
        return user
    }

    #group(group: string): Set<string>{
        const members = this.#groups.get(group)
        if(!members) throw new GroupNotFoundError(group)
        return members
    }

    // The type system already rejects undeclared names; this catches callers without it, as a provider would.
    #checkAttributes(attributes: object){
        for(const name of Object.keys(attributes)){
            if(!this.#attributeNames.has(name)){
                const declared = [...this.#attributeNames].join(", ") || "none"
                throw new TypeError(`Unknown attribute ${name}. Declared attributes: ${declared}`)
            }
        }
    }

    // The cursor is the offset of the page's first item.
    #page<T>(items: T[], cursor: string | null): Page<T>{
        const start = cursor === null ? 0 : Number(cursor)
        const end = start + this.#pageSize
        return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null }
    }
}

function copy<TAttr extends string>(user: IdpUser<TAttr>): IdpUser<TAttr>{
    return { ...user, attributes: { ...user.attributes } }
}
