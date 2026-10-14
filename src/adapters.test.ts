// Adapter conformance: the one test file not paired with a source file. Every adapter runs these same
// scenarios against the IdpAdapter contract, so passing them is what "behaves the same as the other
// adapters" means. Behaviour only one adapter has goes in that adapter's own test file.
//
// To add an adapter, add an entry to `adapters`. One backed by a real provider is skipped unless its
// test settings are in the environment (see CONTRIBUTING.md); CI always sets them.
//
// Emails are on example.com, which never receives mail: real providers may send messages.
import { CognitoAdapter } from "./cognito"
import { COGNITO_TEST_SKIP, createTestPool, type TestPool } from "./cognito/test-pool"
import type { IdpAdapter } from "./adapter"
import { GroupExistsError, GroupNotFoundError, UserExistsError, UserNotFoundError } from "./errors"
import { FakeAdapter } from "./fake"
import { KeycloakAdapter } from "./keycloak"
import { KEYCLOAK_TEST_URL, createTestRealm, type TestRealm } from "./keycloak/test-realm"
import type { IdpUser, Page } from "./types"

type Attr = "company" | "role"

type Setup = {
    adapter: IdpAdapter<Attr>
    // adds a user who signs in through another identity provider, the way the provider itself would;
    // only called when the entry has `federation`
    addFederatedUser(email: string): Promise<string>
}

type AdapterEntry = {
    name: string
    // why it's skipped, or null to run it
    skip: string | null
    // whether setup can add federated users; real Cognito only creates them at an actual SSO sign-in
    federation: boolean
    // a fresh, empty adapter for one test
    setup(options: { pageSize?: number }): Promise<Setup>
    beforeAll?(): Promise<void>
    afterEach?(): Promise<void>
    afterAll?(): Promise<void>
}

const realms: TestRealm[] = []
let pool: TestPool | undefined

const adapters: AdapterEntry[] = [
    {
        name: "FakeAdapter",
        skip: null,
        federation: true,
        async setup({ pageSize }){
            const adapter = new FakeAdapter({ attributes: ["company", "role"], pageSize })
            return { adapter, addFederatedUser: async (email) => adapter.addFederatedUser({ email }).id }
        },
    },
    {
        name: "KeycloakAdapter",
        skip: KEYCLOAK_TEST_URL ? null : "set KEYCLOAK_TEST_URL to run",
        federation: true,
        // a realm per test
        async setup({ pageSize }){
            const realm = await createTestRealm()
            realms.push(realm)
            const adapter = new KeycloakAdapter({
                issuer: realm.issuer,
                clientId: realm.clientId,
                clientSecret: realm.clientSecret,
                // mapped to a different provider name, to exercise the mapping
                attributes: { company: "companyName", role: "role" },
                pageSize,
            })
            return { adapter, addFederatedUser: (email) => realm.addFederatedUser(email) }
        },
        async afterEach(){
            await Promise.all(realms.splice(0).map((realm) => realm.delete()))
        },
    },
    {
        name: "CognitoAdapter",
        skip: COGNITO_TEST_SKIP,
        federation: false,
        // one pool for the file, emptied after each test: creating pools is slow and rate-limited
        async beforeAll(){
            pool = await createTestPool()
        },
        async setup({ pageSize }){
            const adapter = new CognitoAdapter({
                userPoolId: pool!.userPoolId,
                client: pool!.client,
                attributes: { company: "custom:companyName", role: "custom:role" },
                pageSize,
            })
            return { adapter, addFederatedUser: () => Promise.reject(new Error("Cognito can't add federated users")) }
        },
        async afterEach(){
            await pool?.empty()
        },
        async afterAll(){
            await pool?.delete()
        },
    },
]

/** Follows nextCursor to the end, returning every page. */
async function allPages<T>(read: (cursor: string | null) => Promise<Page<T>>){
    const pages: T[][] = []
    let cursor: string | null = null
    do{
        const page: Page<T> = await read(cursor)
        pages.push(page.items)
        cursor = page.nextCursor
    }while(cursor)
    return pages
}

function create(adapter: IdpAdapter<Attr>, email: string){
    return adapter.createUser({ email, temporaryPassword: "Temp-pass-1!" })
}

const MISSING_ID = "00000000-0000-4000-8000-000000000000"

describe.each(adapters)("$name", ({ skip, federation, setup, ...hooks }) => {
    if(skip){
        it.skip(skip, () => {})
        return
    }
    if(hooks.beforeAll) beforeAll(hooks.beforeAll)
    if(hooks.afterEach) afterEach(hooks.afterEach)
    if(hooks.afterAll) afterAll(hooks.afterAll)
    const describeFederated = federation ? describe : describe.skip

    describe("createUser", () => {
        it("creates a user who must change their temporary password", async () => {
            const { adapter } = await setup({})

            const user = await adapter.createUser({
                email: "dana@example.com",
                name: "Dana Lee",
                attributes: { company: "Acme" },
                temporaryPassword: "Temp-pass-1!",
            })

            expect(user).toEqual({
                id: expect.any(String),
                email: "dana@example.com",
                name: "Dana Lee",
                status: "password_change_required",
                enabled: true,
                attributes: { company: "Acme" },
            })
            expect(await adapter.getUser(user.id)).toEqual(user)
        })

        it("gives every user a different id", async () => {
            const { adapter } = await setup({})
            const a = await create(adapter, "a@example.com")
            const b = await create(adapter, "b@example.com")
            expect(a.id).not.toBe(b.id)
        })

        it("leaves name null and attributes empty when they aren't given", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            expect(user).toMatchObject({ name: null, attributes: {} })
        })

        it("throws UserExistsError for an email that's taken", async () => {
            const { adapter } = await setup({})
            await create(adapter, "dana@example.com")
            await expect(create(adapter, "dana@example.com")).rejects.toEqual(new UserExistsError("dana@example.com"))
        })

        it("rejects an attribute it wasn't configured with", async () => {
            const { adapter } = await setup({})

            await expect(adapter.createUser({
                email: "dana@example.com",
                temporaryPassword: "Temp-pass-1!",
                // @ts-expect-error: undeclared attributes are a compile error; this checks the runtime guard
                attributes: { colour: "blue" },
            })).rejects.toThrow(new TypeError("Unknown attribute colour. Declared attributes: company, role"))
            expect(await adapter.findUserByEmail("dana@example.com")).toBeNull()
        })
    })

    describe("getUser", () => {
        it("throws UserNotFoundError for an unknown id", async () => {
            const { adapter } = await setup({})
            await expect(adapter.getUser(MISSING_ID)).rejects.toEqual(new UserNotFoundError(MISSING_ID))
        })
    })

    describe("findUserByEmail", () => {
        it("finds the user with that email", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            expect(await adapter.findUserByEmail("dana@example.com")).toEqual(user)
        })

        it("returns null when nobody has exactly that email", async () => {
            const { adapter } = await setup({})
            await create(adapter, "dana@example.com")
            expect(await adapter.findUserByEmail("nobody@example.com")).toBeNull()
            expect(await adapter.findUserByEmail("dana@example")).toBeNull()
        })

        it("treats an email containing a quote as plain text", async () => {
            const { adapter } = await setup({})
            await create(adapter, "dana@example.com")
            expect(await adapter.findUserByEmail('x" or email = "dana@example.com')).toBeNull()
        })
    })

    describe("listUsersPage", () => {
        it("pages through every user, once each, no page larger than the page size", async () => {
            const { adapter } = await setup({ pageSize: 2 })
            const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]
            for(const email of emails) await create(adapter, email)

            const pages = await allPages((cursor) => adapter.listUsersPage(cursor))

            expect(pages.map((page) => page.length)).toEqual([2, 2, 1])
            expect(pages.flat().map((user) => user.email).sort()).toEqual(emails)
        })

        it("returns one empty last page when there are no users", async () => {
            const { adapter } = await setup({})
            expect(await adapter.listUsersPage(null)).toEqual({ items: [], nextCursor: null })
        })
    })

    describe("setPassword", () => {
        it("makes the user change a temporary password, and clears that once it's permanent", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")

            await adapter.setPassword(user.id, "Their-own-1!", { temporary: false })
            expect((await adapter.getUser(user.id)).status).toBe("active")

            await adapter.setPassword(user.id, "Temp-pass-2!", { temporary: true })
            expect((await adapter.getUser(user.id)).status).toBe("password_change_required")
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            const { adapter } = await setup({})
            await expect(adapter.setPassword(MISSING_ID, "Temp-pass-1!", { temporary: true })).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describeFederated("federated users", () => {
        it("are reported as federated by every read", async () => {
            const { adapter, addFederatedUser } = await setup({})
            const id = await addFederatedUser("sso@example.com")
            await adapter.createGroup("Admin")
            await adapter.addToGroup(id, "Admin")

            const expected = expect.objectContaining({ id, email: "sso@example.com", status: "federated", enabled: true })
            expect(await adapter.getUser(id)).toEqual(expected)
            expect(await adapter.findUserByEmail("sso@example.com")).toEqual(expected)
            expect((await adapter.listUsersPage(null)).items).toEqual([expected])
            expect((await adapter.listGroupMembersPage("Admin", null)).items).toEqual([expected])
        })

        it("stay federated when a password is set for them", async () => {
            const { adapter, addFederatedUser } = await setup({})
            const id = await addFederatedUser("sso@example.com")

            await adapter.setPassword(id, "Temp-pass-1!", { temporary: true })

            expect((await adapter.getUser(id)).status).toBe("federated")
        })
    })

    describe("setEnabled", () => {
        it("disables and re-enables a user, and repeating either is fine", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")

            await adapter.setEnabled(user.id, false)
            await adapter.setEnabled(user.id, false)
            expect((await adapter.getUser(user.id)).enabled).toBe(false)

            await adapter.setEnabled(user.id, true)
            await adapter.setEnabled(user.id, true)
            expect((await adapter.getUser(user.id)).enabled).toBe(true)
        })

        it("keeps everything else about the user while they're disabled", async () => {
            const { adapter } = await setup({})
            const user = await adapter.createUser({
                email: "dana@example.com",
                name: "Dana Lee",
                attributes: { company: "Acme" },
                temporaryPassword: "Temp-pass-1!",
            })

            await adapter.setEnabled(user.id, false)

            expect(await adapter.getUser(user.id)).toEqual({ ...user, enabled: false })
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            const { adapter } = await setup({})
            await expect(adapter.setEnabled(MISSING_ID, false)).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("deleteUser", () => {
        it("removes the user, their email and their group memberships", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            await adapter.createGroup("Admin")
            await adapter.addToGroup(user.id, "Admin")

            await adapter.deleteUser(user.id)

            await expect(adapter.getUser(user.id)).rejects.toBeInstanceOf(UserNotFoundError)
            expect(await adapter.findUserByEmail("dana@example.com")).toBeNull()
            expect(await adapter.listGroupMembersPage("Admin", null)).toEqual({ items: [], nextCursor: null })
        })

        it("frees the email for a new user", async () => {
            const { adapter } = await setup({})
            const first = await create(adapter, "dana@example.com")
            await adapter.deleteUser(first.id)

            const second = await create(adapter, "dana@example.com")

            expect(second.id).not.toBe(first.id)
        })

        it("throws UserNotFoundError for a user who is already gone", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            await adapter.deleteUser(user.id)

            await expect(adapter.deleteUser(user.id)).rejects.toEqual(new UserNotFoundError(user.id))
        })
    })

    describe("updateAttributes", () => {
        it("sets the given attributes and keeps the others", async () => {
            const { adapter } = await setup({})
            const user = await adapter.createUser({
                email: "dana@example.com",
                name: "Dana Lee",
                attributes: { company: "Acme", role: "owner" },
                temporaryPassword: "Temp-pass-1!",
            })

            await adapter.updateAttributes(user.id, { company: "Acme Corp" })

            expect(await adapter.getUser(user.id)).toEqual({ ...user, attributes: { company: "Acme Corp", role: "owner" } })
        })

        it("rejects an attribute it wasn't configured with", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")

            // @ts-expect-error: undeclared attributes are a compile error; this checks the runtime guard
            await expect(adapter.updateAttributes(user.id, { colour: "blue" })).rejects.toThrow(TypeError)
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            const { adapter } = await setup({})
            await expect(adapter.updateAttributes(MISSING_ID, { company: "Acme" })).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("signOutEverywhere", () => {
        it("succeeds for a user with no sessions, and repeating it is fine", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")

            await adapter.signOutEverywhere(user.id)
            await adapter.signOutEverywhere(user.id)
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            const { adapter } = await setup({})
            await expect(adapter.signOutEverywhere(MISSING_ID)).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("groups", () => {
        it("creates a group, and reports whether one exists", async () => {
            const { adapter } = await setup({})
            expect(await adapter.groupExists("Admin")).toBe(false)

            await adapter.createGroup("Admin")

            expect(await adapter.groupExists("Admin")).toBe(true)
            expect(await adapter.groupExists("Adm")).toBe(false)
        })

        it("throws GroupExistsError when creating a group that exists", async () => {
            const { adapter } = await setup({})
            await adapter.createGroup("Admin")
            await expect(adapter.createGroup("Admin")).rejects.toEqual(new GroupExistsError("Admin"))
        })

        it("adds and removes members, and repeating either is fine", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            await adapter.createGroup("Admin")

            await adapter.addToGroup(user.id, "Admin")
            await adapter.addToGroup(user.id, "Admin")
            expect((await adapter.listGroupMembersPage("Admin", null)).items).toEqual([user])
            expect((await adapter.listUserGroupsPage(user.id, null)).items).toEqual(["Admin"])

            await adapter.removeFromGroup(user.id, "Admin")
            await adapter.removeFromGroup(user.id, "Admin")
            expect((await adapter.listGroupMembersPage("Admin", null)).items).toEqual([])
            expect((await adapter.listUserGroupsPage(user.id, null)).items).toEqual([])
        })

        it("doesn't confuse a group with one whose name starts the same", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            await adapter.createGroup("Admin-2")

            await expect(adapter.addToGroup(user.id, "Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
        })

        it("throws GroupNotFoundError when the group doesn't exist", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")

            await expect(adapter.addToGroup(user.id, "Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(adapter.removeFromGroup(user.id, "Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(adapter.listGroupMembersPage("Admin", null)).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(adapter.deleteGroup("Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
        })

        it("throws UserNotFoundError when the user doesn't exist", async () => {
            const { adapter } = await setup({})
            await adapter.createGroup("Admin")

            await expect(adapter.addToGroup(MISSING_ID, "Admin")).rejects.toEqual(new UserNotFoundError(MISSING_ID))
            await expect(adapter.removeFromGroup(MISSING_ID, "Admin")).rejects.toEqual(new UserNotFoundError(MISSING_ID))
            await expect(adapter.listUserGroupsPage(MISSING_ID, null)).rejects.toEqual(new UserNotFoundError(MISSING_ID))
        })

        it("deleting a group removes it from its members", async () => {
            const { adapter } = await setup({})
            const user = await create(adapter, "dana@example.com")
            await adapter.createGroup("contractor-123")
            await adapter.addToGroup(user.id, "contractor-123")

            await adapter.deleteGroup("contractor-123")

            expect(await adapter.groupExists("contractor-123")).toBe(false)
            expect((await adapter.listUserGroupsPage(user.id, null)).items).toEqual([])
        })

        it("pages through a group's members and a user's groups", async () => {
            const { adapter } = await setup({ pageSize: 2 })
            const users: IdpUser<Attr>[] = []
            for(const email of ["a@example.com", "b@example.com", "c@example.com"]) users.push(await create(adapter, email))
            for(const group of ["G1", "G2", "G3"]){
                await adapter.createGroup(group)
                for(const user of users) await adapter.addToGroup(user.id, group)
            }

            const memberPages = await allPages((cursor) => adapter.listGroupMembersPage("G1", cursor))
            const groupPages = await allPages((cursor) => adapter.listUserGroupsPage(users[0].id, cursor))

            expect(memberPages.map((page) => page.length)).toEqual([2, 1])
            expect(memberPages.flat().map((user) => user.email).sort()).toEqual(["a@example.com", "b@example.com", "c@example.com"])
            expect(groupPages.map((page) => page.length)).toEqual([2, 1])
            expect(groupPages.flat().sort()).toEqual(["G1", "G2", "G3"])
        })
    })
})
