// Behaviour only the Cognito adapter has. The IdpAdapter contract every adapter shares is tested in
// src/adapters.test.ts. Most of this runs against a real throwaway user pool; states real Cognito only
// produces at an actual SSO sign-in run against a stub client returning responses shaped like
// Cognito's own.
import {
    AdminGetUserCommand,
    CognitoIdentityProviderClient,
    TooManyRequestsException,
    UserNotFoundException,
    type AdminGetUserCommandOutput,
    type UserType,
} from "@aws-sdk/client-cognito-identity-provider"
import { UserNotFoundError } from "../errors"
import { CognitoAdapter } from "./index"
import { COGNITO_TEST_SKIP, TEST_PASSWORD, createTestPool, type TestPool } from "./test-pool"

describe("CognitoAdapter config", () => {
    it("needs a page size from 1 to 60, Cognito's largest page", () => {
        const base = { userPoolId: "us-east-1_x", region: "us-east-1" }
        expect(() => new CognitoAdapter({ ...base, pageSize: 0 })).toThrow(RangeError)
        expect(() => new CognitoAdapter({ ...base, pageSize: 61 })).toThrow(RangeError)
        expect(() => new CognitoAdapter({ ...base, pageSize: 2.5 })).toThrow(RangeError)
        expect(() => new CognitoAdapter({ ...base, pageSize: 60 })).not.toThrow()
    })

    it("needs either a client or a region", () => {
        expect(() => new CognitoAdapter({ userPoolId: "us-east-1_x" }))
            .toThrow(new TypeError("CognitoAdapter needs either a client or a region"))
    })

    it("exposes its client and user pool through native", () => {
        const client = new CognitoIdentityProviderClient({ region: "us-east-1" })
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })
        expect(adapter.native).toEqual({ client, userPoolId: "us-east-1_x" })
    })
})

// A client whose send answers from `reply`, by command name, recording every call.
function stubClient(reply: (command: string, input: Record<string, unknown>) => unknown){
    const calls: { command: string; input: Record<string, unknown> }[] = []
    const client = {
        send: jest.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
            const name = command.constructor.name.replace(/Command$/, "")
            calls.push({ command: name, input: command.input })
            const result = reply(name, command.input)
            if(result instanceof Error) throw result
            return result
        }),
    } as unknown as CognitoIdentityProviderClient
    return { client, calls }
}

const notFound = () => new UserNotFoundException({ message: "User does not exist.", $metadata: {} })

// An SSO user as Cognito returns them: a provider-qualified Username that isn't the sub.
const SSO_SUB = "84f8a4b8-1031-70b5-2c2e-b4f5c6d7e8f9"
const SSO_USERNAME = "MicrosoftEntraIDSAML_admin@example.com"
const ssoUser: UserType = {
    Username: SSO_USERNAME,
    Attributes: [
        { Name: "sub", Value: SSO_SUB },
        { Name: "email", Value: "admin@example.com" },
        { Name: "name", Value: "An Admin" },
        { Name: "identities", Value: '[{"providerName":"MicrosoftEntraIDSAML","providerType":"SAML"}]' },
    ],
    UserStatus: "EXTERNAL_PROVIDER",
    Enabled: true,
}

// Cognito's admin calls take a local user's sub, but only the Username of an SSO user.
function ssoReply(command: string, input: Record<string, unknown>): unknown{
    if(input.Username === SSO_SUB) return notFound()
    switch(command){
        case "ListUsers":
            return input.Filter === `sub = "${SSO_SUB}"` ? { Users: [ssoUser] } : { Users: [] }
        case "AdminGetUser": {
            const output: Partial<AdminGetUserCommandOutput> = {
                Username: ssoUser.Username, UserAttributes: ssoUser.Attributes, UserStatus: ssoUser.UserStatus, Enabled: ssoUser.Enabled,
            }
            return output
        }
        default:
            return {}
    }
}

describe("CognitoAdapter with SSO users", () => {
    it("reports them as federated", async () => {
        const { client } = stubClient(ssoReply)
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        expect(await adapter.getUser(SSO_SUB)).toEqual({
            id: SSO_SUB, email: "admin@example.com", name: "An Admin", status: "federated", enabled: true, attributes: {},
        })
    })

    it("finds their Username by sub when Cognito won't take the sub, and remembers it", async () => {
        const { client, calls } = stubClient(ssoReply)
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        await adapter.setEnabled(SSO_SUB, false)
        await adapter.removeFromGroup(SSO_SUB, "Admin")

        expect(calls.map((call) => [call.command, call.input.Username ?? call.input.Filter])).toEqual([
            ["AdminDisableUser", SSO_SUB],
            ["ListUsers", `sub = "${SSO_SUB}"`],
            ["AdminDisableUser", SSO_USERNAME],
            ["GetGroup", undefined],
            ["AdminRemoveUserFromGroup", SSO_USERNAME],
        ])
    })

    it("remembers Usernames seen in lists, so later calls need no lookup", async () => {
        const { client, calls } = stubClient((command, input) => command === "ListUsers" && !input.Filter ? { Users: [ssoUser] } : ssoReply(command, input))
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        await adapter.listUsersPage(null)
        await adapter.signOutEverywhere(SSO_SUB)

        expect(calls.map((call) => call.command)).toEqual(["ListUsers", "AdminUserGlobalSignOut"])
        expect(calls[1].input.Username).toBe(SSO_USERNAME)
    })

    it("throws UserNotFoundError when no user has that sub", async () => {
        const { client } = stubClient((command) => command === "ListUsers" ? { Users: [] } : notFound())
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        await expect(adapter.deleteUser("nope")).rejects.toEqual(new UserNotFoundError("nope"))
    })
})

describe("CognitoAdapter statuses", () => {
    it.each([
        ["CONFIRMED", "active"],
        ["FORCE_CHANGE_PASSWORD", "password_change_required"],
        // a temporary password won't get them in; they must reset through the forgot-password flow
        ["RESET_REQUIRED", "password_reset_required"],
        ["COMPROMISED", "password_reset_required"],
        ["UNCONFIRMED", "unconfirmed"],
        ["EXTERNAL_PROVIDER", "federated"],
    ])("reports %s as %s", async (cognitoStatus, status) => {
        const { client } = stubClient(() => ({
            Username: "u-1", UserAttributes: [{ Name: "sub", Value: "u-1" }, { Name: "email", Value: "a@example.com" }], UserStatus: cognitoStatus, Enabled: true,
        }))
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        expect((await adapter.getUser("u-1")).status).toBe(status)
    })
})

describe("CognitoAdapter errors", () => {
    it("passes Cognito errors it doesn't translate through unchanged", async () => {
        const throttled = new TooManyRequestsException({ message: "Too many requests", $metadata: {} })
        const { client } = stubClient(() => throttled)
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        await expect(adapter.getUser("u-1")).rejects.toBe(throttled)
    })

    it("returns null for an email containing a quote without asking Cognito", async () => {
        const { client, calls } = stubClient(() => ({ Users: [] }))
        const adapter = new CognitoAdapter({ userPoolId: "us-east-1_x", client })

        expect(await adapter.findUserByEmail('x" or email = "admin@example.com')).toBeNull()
        expect(calls).toEqual([])
    })
})

const describeCognito = COGNITO_TEST_SKIP ? describe.skip : describe

describeCognito("CognitoAdapter against Cognito", () => {
    let pool: TestPool
    beforeAll(async () => {
        pool = await createTestPool()
    })
    afterEach(async () => {
        await pool.empty()
    })
    afterAll(async () => {
        await pool?.delete()
    })

    function adapter(){
        return new CognitoAdapter({ userPoolId: pool.userPoolId, client: pool.client, attributes: { company: "custom:companyName" } })
    }

    it("uses the id that the user's sign-in tokens carry as sub", async () => {
        const cognito = adapter()
        const user = await cognito.createUser({ email: "dana@example.com", temporaryPassword: "Temp-pass-1!" })
        await cognito.setPassword(user.id, TEST_PASSWORD, { temporary: false })

        const { IdToken } = await pool.signIn("dana@example.com")

        expect(JSON.parse(Buffer.from(IdToken!.split(".")[1], "base64url").toString()).sub).toBe(user.id)
    })

    it("signOutEverywhere revokes the user's refresh tokens", async () => {
        const cognito = adapter()
        const user = await cognito.createUser({ email: "dana@example.com", temporaryPassword: "Temp-pass-1!" })
        await cognito.setPassword(user.id, TEST_PASSWORD, { temporary: false })
        const { RefreshToken } = await pool.signIn("dana@example.com")
        expect(await pool.refresh(RefreshToken!)).toBeNull()

        await cognito.signOutEverywhere(user.id)

        expect(await pool.refresh(RefreshToken!)).toBe("NotAuthorizedException")
    })

    it("stores attributes under their Cognito names, and the name as Cognito's name attribute", async () => {
        const cognito = adapter()

        const user = await cognito.createUser({ email: "dana@example.com", name: "Dana Lee", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" })

        const stored = await cognito.native.client.send(new AdminGetUserCommand({ UserPoolId: pool.userPoolId, Username: user.id }))
        expect(Object.fromEntries((stored.UserAttributes ?? []).map((a) => [a.Name, a.Value]))).toMatchObject({
            "email": "dana@example.com", "email_verified": "true", "name": "Dana Lee", "custom:companyName": "Acme",
        })
    })

    it("creates a user with a provider invitation, and resends it", async () => {
        const cognito = adapter()

        const user = await cognito.createUserWithInvite({ email: "invited@example.com", name: "Invited Person" })
        await cognito.resendInvite(user.id)

        expect(user).toMatchObject({ email: "invited@example.com", status: "password_change_required", enabled: true })
    })

    it("throws UserNotFoundError from resendInvite for an unknown id", async () => {
        await expect(adapter().resendInvite("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(UserNotFoundError)
    })
})
