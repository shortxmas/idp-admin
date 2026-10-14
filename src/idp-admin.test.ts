// IdpAdmin's own rules, on top of an adapter. They don't depend on the provider, so they run against the
// fake; what each adapter does underneath is tested in src/adapters.test.ts.
import type { IdpAdapter } from "./adapter"
import {
    AccessReductionIncompleteError,
    GroupNotFoundError,
    NotSupportedError,
    UserExistsError,
    UserNotFoundError,
} from "./errors"
import { FakeAdapter } from "./fake"
import { IdpAdmin, type AccessReducedEvent } from "./idp-admin"

function setup(options: { pageSize?: number; onAccessReduced?: (event: AccessReducedEvent) => void | Promise<void> } = {}){
    const fake = new FakeAdapter({ attributes: ["company"], pageSize: options.pageSize })
    const events: AccessReducedEvent[] = []
    const admin = new IdpAdmin(fake, {
        onAccessReduced: options.onAccessReduced ?? ((event) => { events.push(event) }),
    })
    return { fake, admin, events }
}

const PASSWORD = "Temp-pass-1!"

async function collect<T>(items: AsyncIterable<T>): Promise<T[]>{
    const all: T[] = []
    for await (const item of items) all.push(item)
    return all
}

describe("IdpAdmin emails", () => {
    it("lowercases and trims emails it creates users with", async () => {
        const { admin } = setup()

        const user = await admin.createUser({ email: "  Dana@Example.COM ", temporaryPassword: PASSWORD })

        expect(user.email).toBe("dana@example.com")
    })

    it("finds a user whatever the case or surrounding spaces of the email", async () => {
        const { admin } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        expect((await admin.findUserByEmail(" DANA@example.com"))?.id).toBe(user.id)
    })

    it("treats emails differing only in case as the same user", async () => {
        const { admin } = setup()
        await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await expect(admin.createUser({ email: "Dana@Example.com", temporaryPassword: PASSWORD }))
            .rejects.toEqual(new UserExistsError("dana@example.com"))
    })

    it("lowercases the email of a user created with a provider invitation", async () => {
        const { admin } = setup()

        expect((await admin.createUserWithInvite({ email: "Invited@Example.com" })).email).toBe("invited@example.com")
    })
})

describe("IdpAdmin lookups", () => {
    it("getUser throws UserNotFoundError and findUserByEmail returns null for a missing user", async () => {
        const { admin } = setup()

        await expect(admin.getUser("nope")).rejects.toEqual(new UserNotFoundError("nope"))
        expect(await admin.findUserByEmail("nobody@example.com")).toBeNull()
    })
})

describe("IdpAdmin deleteUser", () => {
    it("deletes the user, returns true and fires the hook", async () => {
        const { admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        expect(await admin.deleteUser(user.id)).toBe(true)

        expect(await admin.findUserByEmail("dana@example.com")).toBeNull()
        expect(events).toEqual([{ userId: user.id, action: "deleted" }])
    })

    it("returns false for a user who is already gone, and still fires the hook", async () => {
        const { admin, events } = setup()

        expect(await admin.deleteUser("already-gone")).toBe(false)

        expect(events).toEqual([{ userId: "already-gone", action: "deleted" }])
    })

    it("doesn't sign out at the provider, since deleting already ends the user's tokens there", async () => {
        const { fake, admin } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await admin.deleteUser(user.id)

        expect(fake.signOuts).toEqual([])
    })

    it("throws AccessReductionIncompleteError when the hook fails, and leaves the user deleted", async () => {
        const failure = new Error("database unreachable")
        const { admin } = setup({ onAccessReduced: () => { throw failure } })
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        const error = await admin.deleteUser(user.id).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(AccessReductionIncompleteError)
        expect(error).toMatchObject({ userId: user.id, action: "deleted", failedStep: "hook", cause: failure })
        expect(await admin.findUserByEmail("dana@example.com")).toBeNull()
    })

    it("lets the caller retry after a hook failure by calling it again", async () => {
        let calls = 0
        const { admin } = setup({ onAccessReduced: () => { if(++calls === 1) throw new Error("once") } })
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        await expect(admin.deleteUser(user.id)).rejects.toBeInstanceOf(AccessReductionIncompleteError)

        expect(await admin.deleteUser(user.id)).toBe(false)
        expect(calls).toBe(2)
    })

    it("passes other adapter errors through without firing the hook", async () => {
        const fake = new FakeAdapter()
        const outage = new Error("provider down")
        fake.deleteUser = async () => { throw outage }
        const events: AccessReducedEvent[] = []
        const admin = new IdpAdmin(fake, { onAccessReduced: (event) => { events.push(event) } })

        await expect(admin.deleteUser("u-1")).rejects.toBe(outage)
        expect(events).toEqual([])
    })
})

describe("IdpAdmin disableUser and enableUser", () => {
    it("disables the user, signs them out at the provider, then fires the hook", async () => {
        const order: string[] = []
        const { fake, admin } = setup({ onAccessReduced: async (event) => { order.push(`hook ${event.action}`) } })
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        const signOut = fake.signOutEverywhere.bind(fake)
        fake.signOutEverywhere = async (userId) => {
            order.push(`sign-out, enabled: ${(await fake.getUser(userId)).enabled}`)
            await signOut(userId)
        }

        await admin.disableUser(user.id)

        expect((await admin.getUser(user.id)).enabled).toBe(false)
        expect(order).toEqual(["sign-out, enabled: false", "hook disabled"])
    })

    it("succeeds and fires the hook again for a user who is already disabled", async () => {
        const { admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await admin.disableUser(user.id)
        await admin.disableUser(user.id)

        expect(events).toEqual([{ userId: user.id, action: "disabled" }, { userId: user.id, action: "disabled" }])
    })

    it("throws UserNotFoundError for a missing user and fires no hook", async () => {
        const { admin, events } = setup()

        await expect(admin.disableUser("nope")).rejects.toEqual(new UserNotFoundError("nope"))
        expect(events).toEqual([])
    })

    it("throws AccessReductionIncompleteError when provider sign-out fails, without firing the hook", async () => {
        const { fake, admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        const failure = new Error("throttled")
        fake.signOutEverywhere = async () => { throw failure }

        const error = await admin.disableUser(user.id).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(AccessReductionIncompleteError)
        expect(error).toMatchObject({ userId: user.id, action: "disabled", failedStep: "provider-sign-out", cause: failure })
        expect((await admin.getUser(user.id)).enabled).toBe(false)
        expect(events).toEqual([])
    })

    it("throws AccessReductionIncompleteError when the hook fails", async () => {
        const { admin } = setup({ onAccessReduced: () => Promise.reject(new Error("db down")) })
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await expect(admin.disableUser(user.id)).rejects.toMatchObject({ code: "ACCESS_REDUCTION_INCOMPLETE", action: "disabled", failedStep: "hook" })
    })

    it("enableUser re-enables the user and fires no hook", async () => {
        const { admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        await admin.disableUser(user.id)

        await admin.enableUser(user.id)

        expect((await admin.getUser(user.id)).enabled).toBe(true)
        expect(events).toHaveLength(1)
    })
})

describe("IdpAdmin removeFromGroup", () => {
    it("removes the user, signs them out at the provider, and fires the hook with the group", async () => {
        const { fake, admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        await admin.ensureGroup("Admin")
        await admin.addToGroup(user.id, "Admin")

        await admin.removeFromGroup(user.id, "Admin")

        expect(await collect(admin.listUserGroups(user.id))).toEqual([])
        expect(fake.signOuts).toEqual([user.id])
        expect(events).toEqual([{ userId: user.id, action: "removed-from-group", group: "Admin" }])
    })

    it("succeeds and fires the hook for a user who isn't a member, so a failed call can be retried", async () => {
        const { admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        await admin.ensureGroup("Admin")

        await admin.removeFromGroup(user.id, "Admin")

        expect(events).toEqual([{ userId: user.id, action: "removed-from-group", group: "Admin" }])
    })

    it("treats a group that doesn't exist like one the user isn't in", async () => {
        const { admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await admin.removeFromGroup(user.id, "Gone")

        expect(events).toEqual([{ userId: user.id, action: "removed-from-group", group: "Gone" }])
    })

    it("throws UserNotFoundError for a missing user and fires no hook", async () => {
        const { admin, events } = setup()
        await admin.ensureGroup("Admin")

        await expect(admin.removeFromGroup("nope", "Admin")).rejects.toEqual(new UserNotFoundError("nope"))
        expect(events).toEqual([])
    })

    it("throws AccessReductionIncompleteError when the hook fails", async () => {
        const { admin } = setup({ onAccessReduced: () => { throw new Error("db down") } })
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await expect(admin.removeFromGroup(user.id, "Admin"))
            .rejects.toMatchObject({ code: "ACCESS_REDUCTION_INCOMPLETE", userId: user.id, action: "removed-from-group", group: "Admin", failedStep: "hook" })
    })
})

describe("IdpAdmin deleteGroup", () => {
    async function groupWith(admin: IdpAdmin<"company">, group: string, names: string[]){
        await admin.ensureGroup(group)
        const users = []
        for(const name of names){
            const user = await admin.createUser({ email: `${name}@example.com`, temporaryPassword: PASSWORD })
            await admin.addToGroup(user.id, group)
            users.push(user)
        }
        return users
    }

    it("removes and signs out every member, fires the hook for each, then deletes the group", async () => {
        const { fake, admin, events } = setup()
        const [a, b] = await groupWith(admin, "Contractor-1", ["a", "b"])

        await admin.deleteGroup("Contractor-1")

        expect(await fake.groupExists("Contractor-1")).toBe(false)
        expect(fake.signOuts).toEqual([a.id, b.id])
        expect(events).toEqual([
            { userId: a.id, action: "removed-from-group", group: "Contractor-1" },
            { userId: b.id, action: "removed-from-group", group: "Contractor-1" },
        ])
    })

    it("fires each member's hook before the group is deleted", async () => {
        const seen: boolean[] = []
        const { fake, admin } = setup({ onAccessReduced: async () => { seen.push(await fake.groupExists("Contractor-1")) } })
        await groupWith(admin, "Contractor-1", ["a"])

        await admin.deleteGroup("Contractor-1")

        expect(seen).toEqual([true])
    })

    it("reaches every member across pages", async () => {
        const { admin, events } = setup({ pageSize: 2 })
        const users = await groupWith(admin, "Contractor-1", ["a", "b", "c", "d", "e"])

        await admin.deleteGroup("Contractor-1")

        expect(events.map((event) => event.userId)).toEqual(users.map((user) => user.id))
    })

    it("deletes an empty group without firing the hook", async () => {
        const { fake, admin, events } = setup()
        await admin.ensureGroup("Empty")

        await admin.deleteGroup("Empty")

        expect(await fake.groupExists("Empty")).toBe(false)
        expect(events).toEqual([])
    })

    it("throws GroupNotFoundError for a group that doesn't exist", async () => {
        const { admin, events } = setup()

        await expect(admin.deleteGroup("Nope")).rejects.toEqual(new GroupNotFoundError("Nope"))
        expect(events).toEqual([])
    })

    it("stops at a member whose hook fails, leaving the group in place, and can be recovered", async () => {
        let failFor: string | null = null
        const { fake, admin } = setup({ onAccessReduced: ({ userId }) => { if(userId === failFor) throw new Error("db down") } })
        const [, b, c] = await groupWith(admin, "Contractor-1", ["a", "b", "c"])
        failFor = b.id

        const error = await admin.deleteGroup("Contractor-1").catch((e: unknown) => e)

        expect(error).toBeInstanceOf(AccessReductionIncompleteError)
        expect(error).toMatchObject({ userId: b.id, action: "removed-from-group", group: "Contractor-1", failedStep: "hook" })
        expect((error as Error).message).toContain("Call removeFromGroup for this user and group, then deleteGroup again.")
        expect(await fake.groupExists("Contractor-1")).toBe(true)
        expect((await collect(admin.listGroupMembers("Contractor-1"))).map((user) => user.id)).toEqual([c.id])

        failFor = null
        await admin.removeFromGroup(b.id, "Contractor-1")
        await admin.deleteGroup("Contractor-1")
        expect(await fake.groupExists("Contractor-1")).toBe(false)
    })
})

describe("IdpAdmin without a hook", () => {
    it("still signs users out at the provider when access is reduced", async () => {
        const fake = new FakeAdapter()
        const admin = new IdpAdmin(fake)
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await admin.disableUser(user.id)

        expect(fake.signOuts).toEqual([user.id])
    })
})

describe("IdpAdmin groups", () => {
    it("ensureGroup creates a group, and succeeds if it exists", async () => {
        const { admin } = setup()

        await admin.ensureGroup("Admin")
        await admin.ensureGroup("Admin")

        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })
        await admin.addToGroup(user.id, "Admin")
        expect(await collect(admin.listUserGroups(user.id))).toEqual(["Admin"])
    })

    it("ensureGroup succeeds when another caller creates the group at the same moment", async () => {
        const { fake, admin } = setup()
        const create = fake.createGroup.bind(fake)
        // someone else creates it between the existence check and our create
        fake.groupExists = async () => false
        fake.createGroup = async (group) => { await create(group); await create(group) }

        await expect(admin.ensureGroup("Admin")).resolves.toBeUndefined()
    })

    it("addToGroup throws GroupNotFoundError for a group that doesn't exist", async () => {
        const { admin } = setup()
        const user = await admin.createUser({ email: "dana@example.com", temporaryPassword: PASSWORD })

        await expect(admin.addToGroup(user.id, "Nope")).rejects.toEqual(new GroupNotFoundError("Nope"))
    })
})

describe("IdpAdmin lists", () => {
    it("listUsers yields every user across pages, fetching a page only when needed", async () => {
        const { fake, admin } = setup({ pageSize: 2 })
        for(const name of ["a", "b", "c", "d", "e"]) await admin.createUser({ email: `${name}@example.com`, temporaryPassword: PASSWORD })
        const listPage = jest.spyOn(fake, "listUsersPage")

        expect((await collect(admin.listUsers())).map((user) => user.email))
            .toEqual(["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"])
        expect(listPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, "2", "4"])

        listPage.mockClear()
        for await (const user of admin.listUsers()){
            if(user.email === "a@example.com") break
        }
        expect(listPage).toHaveBeenCalledTimes(1)
    })

    it("listGroupMembers and listUserGroups yield across pages", async () => {
        const { admin } = setup({ pageSize: 2 })
        const users = []
        for(const name of ["a", "b", "c"]) users.push(await admin.createUser({ email: `${name}@example.com`, temporaryPassword: PASSWORD }))
        for(const group of ["G1", "G2", "G3"]){
            await admin.ensureGroup(group)
            for(const user of users) await admin.addToGroup(user.id, group)
        }

        expect((await collect(admin.listGroupMembers("G1"))).map((user) => user.email))
            .toEqual(["a@example.com", "b@example.com", "c@example.com"])
        expect(await collect(admin.listUserGroups(users[0].id))).toEqual(["G1", "G2", "G3"])
    })

    it("listGroupMembers throws GroupNotFoundError for a group that doesn't exist", async () => {
        const { admin } = setup()

        await expect(collect(admin.listGroupMembers("Nope"))).rejects.toEqual(new GroupNotFoundError("Nope"))
    })
})

describe("IdpAdmin optional features", () => {
    // an adapter without the optional methods, like Keycloak's
    function withoutInvites(){
        const fake = new FakeAdapter()
        const adapter: IdpAdapter = {
            ...Object.fromEntries(Object.getOwnPropertyNames(FakeAdapter.prototype)
                .filter((name) => name !== "constructor" && typeof (fake as never)[name] === "function")
                .map((name) => [name, (fake as never as Record<string, (...args: unknown[]) => unknown>)[name].bind(fake)])),
            createUserWithInvite: undefined,
            resendInvite: undefined,
        } as IdpAdapter
        return new IdpAdmin(adapter)
    }

    it("throws NotSupportedError for an optional method the adapter lacks", async () => {
        const admin = withoutInvites()

        await expect(admin.createUserWithInvite({ email: "a@example.com" })).rejects.toEqual(new NotSupportedError("createUserWithInvite"))
        await expect(admin.resendInvite("u-1")).rejects.toEqual(new NotSupportedError("resendInvite"))
    })

    it("reports which optional features the adapter supports", () => {
        expect(withoutInvites().supports).toEqual({ createUserWithInvite: false, resendInvite: false })
        expect(setup().admin.supports).toEqual({ createUserWithInvite: true, resendInvite: true })
    })

    it("sends the provider's invitations through the adapter when it has them", async () => {
        const { fake, admin } = setup()

        const user = await admin.createUserWithInvite({ email: "invited@example.com" })
        await admin.resendInvite(user.id)

        expect(fake.invitations).toEqual([{ userId: user.id, email: "invited@example.com" }, { userId: user.id, email: "invited@example.com" }])
    })
})

describe("IdpAdmin passes the rest straight to the adapter", () => {
    it("sets passwords and attributes, and signs users out", async () => {
        const { fake, admin, events } = setup()
        const user = await admin.createUser({ email: "dana@example.com", attributes: { company: "Acme" }, temporaryPassword: PASSWORD })

        await admin.setPassword(user.id, "Their-own-1!", { temporary: false })
        await admin.updateAttributes(user.id, { company: "Initech" })
        await admin.signOutEverywhere(user.id)

        expect(await admin.getUser(user.id)).toMatchObject({ status: "active", attributes: { company: "Initech" } })
        expect(fake.signOuts).toEqual([user.id])
        expect(events).toEqual([])
    })

    it("exposes the adapter, for its native client", () => {
        const { fake, admin } = setup()

        expect(admin.adapter).toBe(fake)
    })

    it("types attributes from the adapter's config", async () => {
        const { admin } = setup()

        // @ts-expect-error not a declared attribute
        await expect(admin.createUser({ email: "a@example.com", attributes: { role: "x" }, temporaryPassword: PASSWORD })).rejects.toThrow(TypeError)
    })
})
