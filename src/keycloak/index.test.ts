// Behaviour only the Keycloak adapter has, against a real Keycloak. The IdpAdapter contract every
// adapter shares is tested in src/adapters.test.ts.
import { KeycloakAdapter } from "./index"
import { ADAPTER_ROLES, KEYCLOAK_TEST_URL, createTestRealm, type TestRealm, type TestRealmOptions } from "./test-realm"

const realms: TestRealm[] = []
afterEach(async () => {
    await Promise.all(realms.splice(0).map((realm) => realm.delete()))
})

async function setup(options: TestRealmOptions = {}){
    const realm = await createTestRealm(options)
    realms.push(realm)
    const adapter = new KeycloakAdapter({
        issuer: realm.issuer,
        clientId: realm.clientId,
        clientSecret: realm.clientSecret,
        attributes: { company: "companyName" },
    })
    return { realm, adapter }
}

type KeycloakUser = { firstName?: string; lastName?: string; attributes?: Record<string, string[]> }

describe("KeycloakAdapter config", () => {
    it("needs an issuer of the form <host>/realms/<realm>", () => {
        expect(() => new KeycloakAdapter({ issuer: "http://localhost:8080", clientId: "c", clientSecret: "s" }))
            .toThrow(new TypeError("issuer must look like <host>/realms/<realm>, got http://localhost:8080"))
    })

    it("accepts an issuer with a trailing slash", () => {
        expect(() => new KeycloakAdapter({ issuer: "http://localhost:8080/realms/frcs/", clientId: "c", clientSecret: "s" })).not.toThrow()
    })

    it("needs a page size from 1 to 99", () => {
        const base = { issuer: "http://localhost:8080/realms/frcs", clientId: "c", clientSecret: "s" }
        expect(() => new KeycloakAdapter({ ...base, pageSize: 0 })).toThrow(RangeError)
        expect(() => new KeycloakAdapter({ ...base, pageSize: 100 })).toThrow(RangeError)
        expect(() => new KeycloakAdapter({ ...base, pageSize: 1.5 })).toThrow(RangeError)
    })

    it("has no provider invitations, so IdpAdmin reports them as not supported", () => {
        const adapter = new KeycloakAdapter({ issuer: "http://localhost:8080/realms/frcs", clientId: "c", clientSecret: "s" })
        expect("createUserWithInvite" in adapter).toBe(false)
        expect("resendInvite" in adapter).toBe(false)
    })
})

const describeKeycloak = KEYCLOAK_TEST_URL ? describe : describe.skip

describeKeycloak("KeycloakAdapter against Keycloak", () => {
    it("uses the id that the user's sign-in tokens carry as sub", async () => {
        const { realm, adapter } = await setup()
        const user = await adapter.createUser({ email: "dana@acme.co", name: "Dana Lee", temporaryPassword: "Temp-pass-1!" })
        await adapter.setPassword(user.id, "Their-own-1!", { temporary: false })

        const { access_token } = await realm.signIn("dana@acme.co", "Their-own-1!")

        const claims = JSON.parse(Buffer.from(access_token!.split(".")[1], "base64url").toString())
        expect(claims.sub).toBe(user.id)
    })

    it("signOutEverywhere ends the user's sessions, so their refresh token stops working", async () => {
        const { realm, adapter } = await setup()
        const user = await adapter.createUser({ email: "dana@acme.co", name: "Dana Lee", temporaryPassword: "Temp-pass-1!" })
        await adapter.setPassword(user.id, "Their-own-1!", { temporary: false })
        const { refresh_token } = await realm.signIn("dana@acme.co", "Their-own-1!")
        expect(await realm.refresh(refresh_token!)).toBeNull()

        await adapter.signOutEverywhere(user.id)

        expect(await realm.refresh(refresh_token!)).toBe("invalid_grant")
    })

    it("splits a name into Keycloak's first and last name, and joins them back", async () => {
        const { realm, adapter } = await setup()

        const full = await adapter.createUser({ email: "a@acme.co", name: "Dana Lee Smith", temporaryPassword: "Temp-pass-1!" })
        const single = await adapter.createUser({ email: "b@acme.co", name: "Dana", temporaryPassword: "Temp-pass-1!" })

        expect((await realm.admin("GET", `/users/${full.id}`)).json).toMatchObject({ firstName: "Dana", lastName: "Lee Smith" })
        expect(((await realm.admin("GET", `/users/${single.id}`)).json as KeycloakUser).lastName).toBeUndefined()
        expect(full.name).toBe("Dana Lee Smith")
        expect(single.name).toBe("Dana")
    })

    it("stores attributes under their Keycloak names", async () => {
        const { realm, adapter } = await setup()

        const user = await adapter.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" })

        expect(((await realm.admin("GET", `/users/${user.id}`)).json as KeycloakUser).attributes).toEqual({ companyName: ["Acme"] })
    })

    it("keeps attributes the app didn't declare when it updates its own", async () => {
        const { realm, adapter } = await setup()
        const user = await adapter.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" })
        const stored = (await realm.admin("GET", `/users/${user.id}`)).json as object
        await realm.admin("PUT", `/users/${user.id}`, { ...stored, attributes: { companyName: ["Acme"], setByAnotherApp: ["x"] } })

        await adapter.updateAttributes(user.id, { company: "Acme Corp" })

        expect(((await realm.admin("GET", `/users/${user.id}`)).json as KeycloakUser).attributes)
            .toEqual({ companyName: ["Acme Corp"], setByAnotherApp: ["x"] })
    })

    it("refuses attributes, before creating anyone, when the realm would silently drop them", async () => {
        const { adapter } = await setup({ unmanagedAttributes: false })

        await expect(adapter.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" }))
            .rejects.toThrow(
                "Keycloak would silently drop the attribute companyName: the realm's user profile doesn't declare it and " +
                "unmanaged attributes are disabled. Declare it in Realm settings → User profile, or set Unmanaged attributes to Enabled.",
            )
        expect(await adapter.findUserByEmail("dana@acme.co")).toBeNull()
    })

    it("accepts an attribute the realm's user profile declares, with unmanaged attributes disabled", async () => {
        const { realm, adapter } = await setup({ unmanagedAttributes: false })
        const profile = (await realm.admin("GET", "/users/profile")).json as { attributes: object[] }
        await realm.admin("PUT", "/users/profile", {
            ...profile,
            attributes: [...profile.attributes, { name: "companyName", displayName: "Company", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false }],
        })

        const user = await adapter.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" })

        expect(user.attributes).toEqual({ company: "Acme" })
    })

    it("creates users without attributes whatever the realm's attribute policy", async () => {
        const { adapter } = await setup({ unmanagedAttributes: false })
        await expect(adapter.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1!" })).resolves.toMatchObject({ email: "dana@acme.co" })
    })

    it("asks for one token and reuses it until it nearly expires", async () => {
        const { realm, adapter } = await setup()
        const fetchSpy = jest.spyOn(globalThis, "fetch")
        try{
            await adapter.listUsersPage(null)
            await adapter.groupExists("Admin")
            await adapter.findUserByEmail("dana@acme.co")

            const tokenRequests = fetchSpy.mock.calls.filter(([url]) => String(url) === `${realm.issuer}/protocol/openid-connect/token`)
            expect(tokenRequests).toHaveLength(1)
        }finally{
            fetchSpy.mockRestore()
        }
    })

    it("explains a rejected client secret", async () => {
        const { realm } = await setup()
        const adapter = new KeycloakAdapter({ issuer: realm.issuer, clientId: realm.clientId, clientSecret: "wrong" })

        await expect(adapter.listUsersPage(null)).rejects.toThrow(
            `Keycloak rejected the client credentials for ${realm.clientId} (401). The client needs Client authentication ` +
            "and Service account roles enabled, and the right secret.",
        )
    })

    it("names the roles the service account needs when Keycloak refuses a call", async () => {
        const { adapter } = await setup({ roles: [] })

        await expect(adapter.listUsersPage(null)).rejects.toThrow(
            `Keycloak refused GET /users (403). The client's service account needs these realm-management roles: ${ADAPTER_ROLES.join(", ")}.`,
        )
    })

    it("works with exactly the documented roles", async () => {
        const { adapter } = await setup({ roles: ADAPTER_ROLES })
        const user = await adapter.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1!" })
        await adapter.createGroup("Admin")
        await adapter.addToGroup(user.id, "Admin")
        await adapter.listGroupMembersPage("Admin", null)
        await adapter.signOutEverywhere(user.id)
        await adapter.deleteGroup("Admin")
        await adapter.deleteUser(user.id)
    })

    it("exposes authenticated admin API requests through native", async () => {
        const { adapter } = await setup()
        await adapter.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1!" })

        const response = await adapter.native.request("GET", "/users/count")

        expect(await response.json()).toBe(1)
    })
})
