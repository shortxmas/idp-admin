import type { AdapterCreateUserInput, IdpAdapter } from "../adapter"
import { GroupExistsError, GroupNotFoundError, UserExistsError, UserNotFoundError } from "../errors"
import type { IdpUser, Page, UserAttributes, UserStatus } from "../types"

export type KeycloakAdapterOptions<TMap extends Record<string, string>> = {
    // the realm's URL, <host>/realms/<realm>: the same value the app uses as its OIDC issuer
    issuer: string
    // a confidential client with a service account that has the roles in KEYCLOAK_ADMIN_ROLES
    clientId: string
    clientSecret: string
    // app attribute name → Keycloak attribute name; only these can be read or written
    attributes?: TMap
    // most items per page from the list methods, 1 to 99; defaults to 50
    pageSize?: number
}

/** The realm-management roles the client's service account needs. `manage-realm` is for creating and deleting groups. */
export const KEYCLOAK_ADMIN_ROLES = ["manage-users", "view-users", "query-users", "query-groups", "manage-realm"] as const

/** Keycloak answered with a status the adapter doesn't turn into an idp-admin error. */
export class KeycloakRequestError extends Error{
    constructor(readonly method: string, readonly path: string, readonly status: number, message: string){
        super(message)
        this.name = "KeycloakRequestError"
    }
}

type KeycloakUser = {
    id: string
    email?: string
    firstName?: string
    lastName?: string
    enabled?: boolean
    requiredActions?: string[]
    attributes?: Record<string, string[]>
}

type UserProfile = {
    unmanagedAttributePolicy?: string
    attributes?: { name: string }[]
}

type RequestOptions = {
    body?: unknown
    // what a 404 means for this call
    notFound?: () => Error
    // what a 409 means for this call
    conflict?: () => Error
}

// Renewed this long before it expires, so a token never lapses mid-request.
const TOKEN_EXPIRY_SKEW_MS = 30_000

type Attr<TMap> = Extract<keyof TMap, string>

/**
 * Keycloak, through its admin REST API, authenticated as a client's service account. A user's id is
 * their Keycloak user id, which Keycloak puts in the `sub` of their tokens. Groups are top-level realm
 * groups, addressed by name. Keycloak has no provider invitation without SMTP and required-action
 * emails, so `createUserWithInvite` and `resendInvite` aren't implemented.
 */
export class KeycloakAdapter<const TMap extends Record<string, string> = {}> implements IdpAdapter<Attr<TMap>>{
    readonly #realmUrl: string
    readonly #adminUrl: string
    readonly #clientId: string
    readonly #clientSecret: string
    readonly #attributes: ReadonlyMap<string, string>
    readonly #pageSize: number
    #token: Promise<{ value: string; expiresAt: number }> | undefined
    #profile: Promise<UserProfile> | undefined

    /** The admin API, authenticated, for anything the shared interface doesn't cover. Paths are relative to /admin/realms/<realm>. */
    readonly native: {
        adminUrl: string
        request(method: string, path: string, body?: unknown): Promise<Response>
    }

    constructor(options: KeycloakAdapterOptions<TMap>){
        const match = options.issuer.replace(/\/+$/, "").match(/^(.*)\/realms\/([^/]+)$/)
        if(!match) throw new TypeError(`issuer must look like <host>/realms/<realm>, got ${options.issuer}`)
        const [, host, realm] = match
        const pageSize = options.pageSize ?? 50
        if(!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 99) throw new RangeError(`pageSize must be a whole number from 1 to 99, got ${pageSize}`)

        this.#realmUrl = `${host}/realms/${realm}`
        this.#adminUrl = `${host}/admin/realms/${realm}`
        this.#clientId = options.clientId
        this.#clientSecret = options.clientSecret
        this.#attributes = new Map(Object.entries(options.attributes ?? {}))
        this.#pageSize = pageSize
        this.native = {
            adminUrl: this.#adminUrl,
            request: async (method, path, body) => this.#fetch(method, path, body),
        }
    }

    async createUser(input: AdapterCreateUserInput<Attr<TMap>>): Promise<IdpUser<Attr<TMap>>>{
        const attributes = await this.#toKeycloakAttributes(input.attributes)
        const response = await this.#request("POST", "/users", {
            body: {
                username: input.email,
                email: input.email,
                emailVerified: true,
                enabled: true,
                ...splitName(input.name),
                attributes,
                credentials: [{ type: "password", value: input.temporaryPassword, temporary: true }],
            },
            conflict: () => new UserExistsError(input.email),
        })
        // Keycloak returns the new user's id only in the Location header
        const id = response.headers.get("location")!.split("/").pop()!
        return this.getUser(id)
    }

    async getUser(userId: string): Promise<IdpUser<Attr<TMap>>>{
        const response = await this.#request("GET", `/users/${encodeURIComponent(userId)}`, { notFound: () => new UserNotFoundError(userId) })
        return this.#toUser(await response.json())
    }

    async findUserByEmail(email: string): Promise<IdpUser<Attr<TMap>> | null>{
        const response = await this.#request("GET", `/users?email=${encodeURIComponent(email)}&exact=true&briefRepresentation=false`)
        const match = ((await response.json()) as KeycloakUser[]).find((user) => user.email === email)
        return match ? this.#toUser(match) : null
    }

    async listUsersPage(cursor: string | null): Promise<Page<IdpUser<Attr<TMap>>>>{
        return this.#page(cursor, "/users?briefRepresentation=false", async (users: KeycloakUser[]) => Promise.all(users.map((user) => this.#toUser(user))))
    }

    async setPassword(userId: string, password: string, options: { temporary: boolean }): Promise<void>{
        await this.#request("PUT", `/users/${encodeURIComponent(userId)}/reset-password`, {
            body: { type: "password", value: password, temporary: options.temporary },
            notFound: () => new UserNotFoundError(userId),
        })
    }

    async setEnabled(userId: string, enabled: boolean): Promise<void>{
        // a partial representation: Keycloak leaves every field it doesn't contain unchanged
        await this.#request("PUT", `/users/${encodeURIComponent(userId)}`, { body: { enabled }, notFound: () => new UserNotFoundError(userId) })
    }

    async deleteUser(userId: string): Promise<void>{
        await this.#request("DELETE", `/users/${encodeURIComponent(userId)}`, { notFound: () => new UserNotFoundError(userId) })
    }

    async updateAttributes(userId: string, attributes: UserAttributes<Attr<TMap>>): Promise<void>{
        const changes = await this.#toKeycloakAttributes(attributes)
        const path = `/users/${encodeURIComponent(userId)}`
        const current = (await (await this.#request("GET", path, { notFound: () => new UserNotFoundError(userId) })).json()) as KeycloakUser
        // Keycloak replaces the whole attribute map, and with its user profile that map includes email and
        // names: send the whole user back, with the attributes this app didn't declare unchanged
        await this.#request("PUT", path, {
            body: { ...current, attributes: { ...current.attributes, ...changes } },
            notFound: () => new UserNotFoundError(userId),
        })
    }

    async signOutEverywhere(userId: string): Promise<void>{
        await this.#request("POST", `/users/${encodeURIComponent(userId)}/logout`, { notFound: () => new UserNotFoundError(userId) })
    }

    async addToGroup(userId: string, group: string): Promise<void>{
        const groupId = await this.#requireGroupId(group)
        await this.#request("PUT", `/users/${encodeURIComponent(userId)}/groups/${groupId}`, { notFound: () => new UserNotFoundError(userId) })
    }

    async removeFromGroup(userId: string, group: string): Promise<void>{
        const groupId = await this.#requireGroupId(group)
        await this.#request("DELETE", `/users/${encodeURIComponent(userId)}/groups/${groupId}`, { notFound: () => new UserNotFoundError(userId) })
    }

    async listUserGroupsPage(userId: string, cursor: string | null): Promise<Page<string>>{
        const path = `/users/${encodeURIComponent(userId)}/groups?briefRepresentation=true`
        return this.#page(cursor, path, async (groups: { name: string }[]) => groups.map((group) => group.name), () => new UserNotFoundError(userId))
    }

    async groupExists(group: string): Promise<boolean>{
        return (await this.#groupId(group)) !== null
    }

    async createGroup(group: string): Promise<void>{
        await this.#request("POST", "/groups", { body: { name: group }, conflict: () => new GroupExistsError(group) })
    }

    async deleteGroup(group: string): Promise<void>{
        const groupId = await this.#requireGroupId(group)
        await this.#request("DELETE", `/groups/${groupId}`, { notFound: () => new GroupNotFoundError(group) })
    }

    async listGroupMembersPage(group: string, cursor: string | null): Promise<Page<IdpUser<Attr<TMap>>>>{
        const groupId = await this.#requireGroupId(group)
        const path = `/groups/${groupId}/members?briefRepresentation=false`
        return this.#page(cursor, path, async (users: KeycloakUser[]) => Promise.all(users.map((user) => this.#toUser(user))), () => new GroupNotFoundError(group))
    }

    // One page from a Keycloak list endpoint that takes first/max. Asks for one item more than a page,
    // so the last page is known to be the last without an extra request.
    async #page<TRaw, TItem>(cursor: string | null, path: string, map: (raw: TRaw[]) => Promise<TItem[]>, notFound?: () => Error): Promise<Page<TItem>>{
        const first = cursor === null ? 0 : Number(cursor)
        const response = await this.#request("GET", `${path}&first=${first}&max=${this.#pageSize + 1}`, { notFound })
        const raw = (await response.json()) as TRaw[]
        const more = raw.length > this.#pageSize
        return { items: await map(raw.slice(0, this.#pageSize)), nextCursor: more ? String(first + this.#pageSize) : null }
    }

    async #toUser(user: KeycloakUser): Promise<IdpUser<Attr<TMap>>>{
        // a link to an identity provider is the only sign of an SSO user, and Keycloak keeps it off the user
        const links = await this.#request("GET", `/users/${encodeURIComponent(user.id)}/federated-identity`, { notFound: () => new UserNotFoundError(user.id) })
        const federated = ((await links.json()) as unknown[]).length > 0
        const attributes: Record<string, string> = {}
        for(const [appName, keycloakName] of this.#attributes){
            const value = user.attributes?.[keycloakName]?.[0]
            if(value !== undefined) attributes[appName] = value
        }
        return {
            id: user.id,
            email: user.email ?? "",
            name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
            status: statusOf(user, federated),
            enabled: user.enabled ?? false,
            attributes: attributes as UserAttributes<Attr<TMap>>,
        }
    }

    // Checks every name is declared, then that the realm will keep them: with Keycloak's user profile,
    // an attribute it doesn't declare is dropped without an error unless unmanaged attributes are enabled.
    async #toKeycloakAttributes(attributes: object | undefined): Promise<Record<string, string[]>>{
        const entries = Object.entries(attributes ?? {}) as [string, string][]
        const result: Record<string, string[]> = {}
        for(const [name, value] of entries){
            const keycloakName = this.#attributes.get(name)
            if(keycloakName === undefined){
                const declared = [...this.#attributes.keys()].join(", ") || "none"
                throw new TypeError(`Unknown attribute ${name}. Declared attributes: ${declared}`)
            }
            result[keycloakName] = [value]
        }
        if(entries.length) await this.#assertRealmKeeps(Object.keys(result))
        return result
    }

    async #assertRealmKeeps(keycloakNames: string[]){
        this.#profile ??= this.#request("GET", "/users/profile").then((response) => response.json() as Promise<UserProfile>)
        let profile: UserProfile
        try{
            profile = await this.#profile
        }catch(error){
            this.#profile = undefined
            throw error
        }
        if(profile.unmanagedAttributePolicy === "ENABLED" || profile.unmanagedAttributePolicy === "ADMIN_EDIT") return
        const declared = new Set((profile.attributes ?? []).map((attribute) => attribute.name))
        const dropped = keycloakNames.find((name) => !declared.has(name))
        if(dropped === undefined) return
        // read the profile again next time, so fixing the realm doesn't need a restart
        this.#profile = undefined
        throw new Error(
            `Keycloak would silently drop the attribute ${dropped}: the realm's user profile doesn't declare it and ` +
            "unmanaged attributes are disabled. Declare it in Realm settings → User profile, or set Unmanaged attributes to Enabled.",
        )
    }

    // The id of the top-level group with exactly this name, or null.
    async #groupId(group: string): Promise<string | null>{
        const response = await this.#request("GET", `/groups?search=${encodeURIComponent(group)}&exact=true&briefRepresentation=true`)
        const match = ((await response.json()) as { id: string; name: string }[]).find((candidate) => candidate.name === group)
        return match?.id ?? null
    }

    async #requireGroupId(group: string): Promise<string>{
        const id = await this.#groupId(group)
        if(id === null) throw new GroupNotFoundError(group)
        return id
    }

    async #request(method: string, path: string, options: RequestOptions = {}): Promise<Response>{
        const response = await this.#fetch(method, path, options.body)
        if(response.ok) return response
        const where = `${method} ${path.split("?")[0]}`
        if(response.status === 404 && options.notFound) throw options.notFound()
        if(response.status === 409 && options.conflict) throw options.conflict()
        if(response.status === 403){
            throw new KeycloakRequestError(method, path, 403,
                `Keycloak refused ${where} (403). The client's service account needs these realm-management roles: ${KEYCLOAK_ADMIN_ROLES.join(", ")}.`)
        }
        const detail = await response.text().catch(() => "")
        throw new KeycloakRequestError(method, path, response.status, `Keycloak ${where} failed (${response.status}): ${detail}`)
    }

    async #fetch(method: string, path: string, body?: unknown): Promise<Response>{
        return fetch(`${this.#adminUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${await this.#accessToken()}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
    }

    // A client-credentials token, shared by concurrent calls and reused until shortly before it expires.
    async #accessToken(): Promise<string>{
        const cached = this.#token && (await this.#token.catch(() => undefined))
        if(cached && cached.expiresAt > Date.now()) return cached.value
        this.#token = this.#requestToken()
        try{
            return (await this.#token).value
        }catch(error){
            this.#token = undefined
            throw error
        }
    }

    async #requestToken(){
        const response = await fetch(`${this.#realmUrl}/protocol/openid-connect/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.#clientId, client_secret: this.#clientSecret }),
        })
        if(!response.ok){
            throw new KeycloakRequestError("POST", "/protocol/openid-connect/token", response.status,
                `Keycloak rejected the client credentials for ${this.#clientId} (${response.status}). The client needs Client authentication ` +
                "and Service account roles enabled, and the right secret.")
        }
        const body = (await response.json()) as { access_token: string; expires_in?: number }
        return { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 60) * 1000 - TOKEN_EXPIRY_SKEW_MS }
    }
}

// Keycloak keeps a first and a last name; the first word is the first name, the rest the last.
function splitName(name: string | undefined){
    const [firstName, ...rest] = (name ?? "").trim().split(/\s+/).filter(Boolean)
    return { ...(firstName ? { firstName } : {}), ...(rest.length ? { lastName: rest.join(" ") } : {}) }
}

function statusOf(user: KeycloakUser, federated: boolean): UserStatus{
    if(federated) return "federated"
    if(user.requiredActions?.includes("UPDATE_PASSWORD")) return "password_change_required"
    if(user.requiredActions?.includes("VERIFY_EMAIL")) return "unconfirmed"
    return "active"
}
