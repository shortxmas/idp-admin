import {
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminDisableUserCommand,
    AdminEnableUserCommand,
    AdminGetUserCommand,
    AdminListGroupsForUserCommand,
    AdminRemoveUserFromGroupCommand,
    AdminSetUserPasswordCommand,
    AdminUpdateUserAttributesCommand,
    AdminUserGlobalSignOutCommand,
    CognitoIdentityProviderClient,
    CreateGroupCommand,
    DeleteGroupCommand,
    GetGroupCommand,
    ListUsersCommand,
    ListUsersInGroupCommand,
    type AttributeType,
    type CognitoIdentityProviderClientConfig,
    type UserType,
} from "@aws-sdk/client-cognito-identity-provider"
import type { AdapterCreateUserInput, AdapterInviteUserInput, IdpAdapter } from "../adapter"
import { GroupExistsError, GroupNotFoundError, UserExistsError, UserNotFoundError } from "../errors"
import type { IdpUser, Page, UserAttributes, UserStatus } from "../types"

export type CognitoAdapterOptions<TMap extends Record<string, string>> = {
    userPoolId: string
    // a client you configured; otherwise one is built from region and credentials
    client?: CognitoIdentityProviderClient
    region?: string
    // defaults to the AWS SDK's own credential chain
    credentials?: CognitoIdentityProviderClientConfig["credentials"]
    // app attribute name → Cognito attribute name, e.g. { company: "custom:companyName" }
    attributes?: TMap
    // most items per page from the list methods, 1 to 60; defaults to 60, Cognito's largest page
    pageSize?: number
}

type Attr<TMap> = Extract<keyof TMap, string>

// A user as ListUsers, ListUsersInGroup, AdminCreateUser and AdminGetUser describe them.
type CognitoUser = Pick<UserType, "Username" | "Attributes" | "UserStatus" | "Enabled">

const STATUSES: Record<string, UserStatus> = {
    CONFIRMED: "active",
    FORCE_CHANGE_PASSWORD: "password_change_required",
    // an admin reset the password; the user must use the forgot-password code to set a new one
    RESET_REQUIRED: "password_reset_required",
    // Cognito suspects the password leaked, so the user must reset it the same way
    COMPROMISED: "password_reset_required",
    UNCONFIRMED: "unconfirmed",
    EXTERNAL_PROVIDER: "federated",
}

/**
 * Amazon Cognito, through the user pool admin API. A user's id is their `sub`. Cognito's admin calls
 * take a local user's sub directly, but an SSO user only by their provider-qualified Username, so for
 * those the adapter looks the Username up by sub once and remembers it.
 */
export class CognitoAdapter<const TMap extends Record<string, string> = {}> implements IdpAdapter<Attr<TMap>>{
    readonly #client: CognitoIdentityProviderClient
    readonly #userPoolId: string
    readonly #attributes: ReadonlyMap<string, string>
    readonly #pageSize: number
    // sub → Username, for users whose Username isn't their sub
    readonly #usernames = new Map<string, string>()

    /** The client and user pool, for anything the shared interface doesn't cover. */
    readonly native: { client: CognitoIdentityProviderClient; userPoolId: string }

    constructor(options: CognitoAdapterOptions<TMap>){
        if(!options.client && !options.region) throw new TypeError("CognitoAdapter needs either a client or a region")
        const pageSize = options.pageSize ?? 60
        if(!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 60) throw new RangeError(`pageSize must be a whole number from 1 to 60, got ${pageSize}`)

        this.#client = options.client ?? new CognitoIdentityProviderClient({ region: options.region, credentials: options.credentials })
        this.#userPoolId = options.userPoolId
        this.#attributes = new Map(Object.entries(options.attributes ?? {}))
        this.#pageSize = pageSize
        this.native = { client: this.#client, userPoolId: this.#userPoolId }
    }

    async createUser(input: AdapterCreateUserInput<Attr<TMap>>): Promise<IdpUser<Attr<TMap>>>{
        return this.#create(input, { TemporaryPassword: input.temporaryPassword, MessageAction: "SUPPRESS" })
    }

    async createUserWithInvite(input: AdapterInviteUserInput<Attr<TMap>>): Promise<IdpUser<Attr<TMap>>>{
        return this.#create(input, { DesiredDeliveryMediums: ["EMAIL"] })
    }

    async getUser(userId: string): Promise<IdpUser<Attr<TMap>>>{
        const output = await this.#withUser(userId, (Username) => this.#client.send(new AdminGetUserCommand({ UserPoolId: this.#userPoolId, Username })))
        return this.#toUser({ ...output, Attributes: output.UserAttributes })
    }

    async findUserByEmail(email: string): Promise<IdpUser<Attr<TMap>> | null>{
        // Cognito's filter syntax quotes the value and has no escape for a quote, so an email containing
        // one can't be looked up safely; Cognito doesn't accept such emails anyway
        if(email.includes('"')) return null
        const { Users } = await this.#client.send(new ListUsersCommand({ UserPoolId: this.#userPoolId, Filter: `email = "${email}"`, Limit: 1 }))
        return Users?.[0] ? this.#toUser(Users[0]) : null
    }

    async listUsersPage(cursor: string | null): Promise<Page<IdpUser<Attr<TMap>>>>{
        const output = await this.#client.send(new ListUsersCommand({
            UserPoolId: this.#userPoolId, Limit: this.#pageSize, PaginationToken: cursor ?? undefined,
        }))
        return { items: (output.Users ?? []).map((user) => this.#toUser(user)), nextCursor: output.PaginationToken ?? null }
    }

    async setPassword(userId: string, password: string, options: { temporary: boolean }): Promise<void>{
        await this.#withUser(userId, (Username) => this.#client.send(new AdminSetUserPasswordCommand({
            UserPoolId: this.#userPoolId, Username, Password: password, Permanent: !options.temporary,
        })))
    }

    async setEnabled(userId: string, enabled: boolean): Promise<void>{
        await this.#withUser(userId, (Username) => this.#client.send(enabled
            ? new AdminEnableUserCommand({ UserPoolId: this.#userPoolId, Username })
            : new AdminDisableUserCommand({ UserPoolId: this.#userPoolId, Username })))
    }

    async deleteUser(userId: string): Promise<void>{
        await this.#withUser(userId, (Username) => this.#client.send(new AdminDeleteUserCommand({ UserPoolId: this.#userPoolId, Username })))
        this.#usernames.delete(userId)
    }

    async updateAttributes(userId: string, attributes: UserAttributes<Attr<TMap>>): Promise<void>{
        const UserAttributes = this.#toCognitoAttributes(attributes)
        // Cognito changes only the attributes it's given
        await this.#withUser(userId, (Username) => this.#client.send(new AdminUpdateUserAttributesCommand({ UserPoolId: this.#userPoolId, Username, UserAttributes })))
    }

    async resendInvite(userId: string): Promise<void>{
        // unlike the other admin calls, a resend in a pool that signs in by email takes only the email,
        // not the sub; createUser always makes the email the username
        const { email } = await this.getUser(userId)
        await this.#client.send(new AdminCreateUserCommand({
            UserPoolId: this.#userPoolId, Username: email, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"],
        }))
    }

    async signOutEverywhere(userId: string): Promise<void>{
        await this.#withUser(userId, (Username) => this.#client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.#userPoolId, Username })))
    }

    async addToGroup(userId: string, group: string): Promise<void>{
        await this.#withUser(userId, (Username) => this.#groupCall(group, () =>
            this.#client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.#userPoolId, Username, GroupName: group }))))
    }

    async removeFromGroup(userId: string, group: string): Promise<void>{
        // Cognito succeeds silently when the group doesn't exist, so check first
        if(!(await this.groupExists(group))) throw new GroupNotFoundError(group)
        await this.#withUser(userId, (Username) => this.#client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.#userPoolId, Username, GroupName: group })))
    }

    async listUserGroupsPage(userId: string, cursor: string | null): Promise<Page<string>>{
        const output = await this.#withUser(userId, (Username) => this.#client.send(new AdminListGroupsForUserCommand({
            UserPoolId: this.#userPoolId, Username, Limit: this.#pageSize, NextToken: cursor ?? undefined,
        })))
        return { items: (output.Groups ?? []).map((group) => group.GroupName!), nextCursor: output.NextToken ?? null }
    }

    async groupExists(group: string): Promise<boolean>{
        try{
            await this.#groupCall(group, () => this.#client.send(new GetGroupCommand({ UserPoolId: this.#userPoolId, GroupName: group })))
            return true
        }catch(error){
            if(error instanceof GroupNotFoundError) return false
            throw error
        }
    }

    async createGroup(group: string): Promise<void>{
        try{
            await this.#client.send(new CreateGroupCommand({ UserPoolId: this.#userPoolId, GroupName: group }))
        }catch(error){
            if(nameOf(error) === "GroupExistsException") throw new GroupExistsError(group)
            throw error
        }
    }

    async deleteGroup(group: string): Promise<void>{
        await this.#groupCall(group, () => this.#client.send(new DeleteGroupCommand({ UserPoolId: this.#userPoolId, GroupName: group })))
    }

    async listGroupMembersPage(group: string, cursor: string | null): Promise<Page<IdpUser<Attr<TMap>>>>{
        const output = await this.#groupCall(group, () => this.#client.send(new ListUsersInGroupCommand({
            UserPoolId: this.#userPoolId, GroupName: group, Limit: this.#pageSize, NextToken: cursor ?? undefined,
        })))
        return { items: (output.Users ?? []).map((user) => this.#toUser(user)), nextCursor: output.NextToken ?? null }
    }

    async #create(input: AdapterInviteUserInput<Attr<TMap>>, delivery: Partial<ConstructorParameters<typeof AdminCreateUserCommand>[0]>){
        const custom = this.#toCognitoAttributes(input.attributes)
        try{
            const { User } = await this.#client.send(new AdminCreateUserCommand({
                UserPoolId: this.#userPoolId,
                Username: input.email,
                UserAttributes: [
                    { Name: "email", Value: input.email },
                    // an admin typed the address in, so the user isn't asked to confirm it
                    { Name: "email_verified", Value: "true" },
                    ...(input.name ? [{ Name: "name", Value: input.name }] : []),
                    ...custom,
                ],
                ...delivery,
            }))
            return this.#toUser(User!)
        }catch(error){
            if(nameOf(error) === "UsernameExistsException" || nameOf(error) === "AliasExistsException") throw new UserExistsError(input.email)
            throw error
        }
    }

    // Runs `call` with the user's Username: their sub, unless they're an SSO user Cognito knows only by
    // a provider-qualified Username, which is looked up by sub once and remembered.
    async #withUser<T>(userId: string, call: (username: string) => Promise<T>): Promise<T>{
        const known = this.#usernames.get(userId)
        try{
            return await call(known ?? userId)
        }catch(error){
            if(nameOf(error) !== "UserNotFoundException") throw error
            if(known !== undefined){
                this.#usernames.delete(userId)
                throw new UserNotFoundError(userId)
            }
        }
        const username = await this.#usernameBySub(userId)
        if(username === null || username === userId) throw new UserNotFoundError(userId)
        this.#usernames.set(userId, username)
        try{
            return await call(username)
        }catch(error){
            if(nameOf(error) === "UserNotFoundException") throw new UserNotFoundError(userId)
            throw error
        }
    }

    async #usernameBySub(sub: string): Promise<string | null>{
        // a sub is a UUID; anything with a quote can't be one, and would break out of the filter
        if(sub.includes('"')) return null
        const { Users } = await this.#client.send(new ListUsersCommand({ UserPoolId: this.#userPoolId, Filter: `sub = "${sub}"`, Limit: 1 }))
        return Users?.[0]?.Username ?? null
    }

    // Runs a call that addresses a group, turning Cognito's "not found" into GroupNotFoundError.
    async #groupCall<T>(group: string, call: () => Promise<T>): Promise<T>{
        try{
            return await call()
        }catch(error){
            if(nameOf(error) === "ResourceNotFoundException") throw new GroupNotFoundError(group)
            throw error
        }
    }

    #toUser(user: CognitoUser): IdpUser<Attr<TMap>>{
        const values = new Map((user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value]))
        const id = values.get("sub")!
        if(user.Username && user.Username !== id) this.#usernames.set(id, user.Username)
        const attributes: Record<string, string> = {}
        for(const [appName, cognitoName] of this.#attributes){
            const value = values.get(cognitoName)
            if(value !== undefined) attributes[appName] = value
        }
        return {
            id,
            email: values.get("email") ?? "",
            name: values.get("name") ?? null,
            status: STATUSES[user.UserStatus ?? ""] ?? "active",
            enabled: user.Enabled ?? false,
            attributes: attributes as UserAttributes<Attr<TMap>>,
        }
    }

    #toCognitoAttributes(attributes: object | undefined): AttributeType[]{
        return (Object.entries(attributes ?? {}) as [string, string][]).map(([name, value]) => {
            const cognitoName = this.#attributes.get(name)
            if(cognitoName === undefined){
                const declared = [...this.#attributes.keys()].join(", ") || "none"
                throw new TypeError(`Unknown attribute ${name}. Declared attributes: ${declared}`)
            }
            return { Name: cognitoName, Value: value }
        })
    }
}

function nameOf(error: unknown){
    return (error as { name?: string } | null)?.name
}
