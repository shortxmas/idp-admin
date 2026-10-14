import type { IdpAdapter } from "../adapter"
import { GroupExistsError, GroupNotFoundError, UserExistsError, UserNotFoundError } from "../errors"
import type { IdpUser, Page } from "../types"
import { FakeAdapter } from "./index"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

async function createUser(fake: FakeAdapter<"company">, email: string){
    return fake.createUser({ email, temporaryPassword: "Temp-pass-1" })
}

describe("FakeAdapter", () => {
    it("implements IdpAdapter with the attribute names from its config", () => {
        const adapter: IdpAdapter<"company"> = new FakeAdapter({ attributes: ["company"] })
        expect(adapter).toBeInstanceOf(FakeAdapter)
    })

    describe("createUser", () => {
        it("creates a user with a UUID v4 id who must change their temporary password", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })

            const user = await fake.createUser({
                email: "dana@acme.co",
                name: "Dana Lee",
                attributes: { company: "Acme" },
                temporaryPassword: "Temp-pass-1",
            })

            expect(user).toEqual({
                id: expect.stringMatching(UUID_V4),
                email: "dana@acme.co",
                name: "Dana Lee",
                status: "password_change_required",
                enabled: true,
                attributes: { company: "Acme" },
            })
            expect(await fake.getUser(user.id)).toEqual(user)
        })

        it("gives every user a different id", async () => {
            const fake = new FakeAdapter()
            const a = await fake.createUser({ email: "a@acme.co", temporaryPassword: "Temp-pass-1" })
            const b = await fake.createUser({ email: "b@acme.co", temporaryPassword: "Temp-pass-1" })
            expect(a.id).not.toBe(b.id)
        })

        it("leaves name null and attributes empty when they aren't given", async () => {
            const fake = new FakeAdapter()
            const user = await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
            expect(user).toMatchObject({ name: null, attributes: {} })
        })

        it("sends no invitation, because the app sends its own", async () => {
            const fake = new FakeAdapter()
            await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
            expect(fake.invitations).toEqual([])
        })

        it("throws UserExistsError for an email that's taken", async () => {
            const fake = new FakeAdapter()
            await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })

            await expect(fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" }))
                .rejects.toEqual(new UserExistsError("dana@acme.co"))
        })

        it("rejects every attribute when its config declares none", async () => {
            const fake = new FakeAdapter()

            await expect(fake.createUser({
                email: "dana@acme.co",
                temporaryPassword: "Temp-pass-1",
                // @ts-expect-error: with no attributes declared, any attribute is a compile error
                attributes: { company: "Acme" },
            })).rejects.toThrow("Unknown attribute company. Declared attributes: none")
        })

        it("rejects an attribute its config didn't declare", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })

            await expect(fake.createUser({
                email: "dana@acme.co",
                temporaryPassword: "Temp-pass-1",
                // @ts-expect-error: undeclared attributes are a compile error; this checks the runtime guard
                attributes: { compnay: "Acme" },
            })).rejects.toThrow("Unknown attribute compnay. Declared attributes: company")
        })
    })

    describe("createUserWithInvite", () => {
        it("creates a user who must set a password, and records the provider's invitation", async () => {
            const fake = new FakeAdapter()

            const user = await fake.createUserWithInvite({ email: "dana@acme.co", name: "Dana Lee" })

            expect(user.status).toBe("password_change_required")
            expect(fake.invitations).toEqual([{ userId: user.id, email: "dana@acme.co" }])
        })

        it("throws UserExistsError for an email that's taken", async () => {
            const fake = new FakeAdapter()
            await fake.createUserWithInvite({ email: "dana@acme.co" })

            await expect(fake.createUserWithInvite({ email: "dana@acme.co" })).rejects.toBeInstanceOf(UserExistsError)
            expect(fake.invitations).toHaveLength(1)
        })
    })

    describe("addFederatedUser", () => {
        it("adds an SSO user, who has no password to change", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })

            const user = fake.addFederatedUser({ email: "admin@mc3.co", name: "An Admin", attributes: { company: "MC3" } })

            expect(user).toMatchObject({ email: "admin@mc3.co", status: "federated", enabled: true, attributes: { company: "MC3" } })
            expect(await fake.findUserByEmail("admin@mc3.co")).toEqual(user)
        })
    })

    describe("getUser", () => {
        it("throws UserNotFoundError for an unknown id", async () => {
            await expect(new FakeAdapter().getUser("nope")).rejects.toEqual(new UserNotFoundError("nope"))
        })

        it("returns a copy, so changing it doesn't change the stored user", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })
            const created = await fake.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1" })

            const read = await fake.getUser(created.id)
            read.name = "Changed"
            read.attributes.company = "Changed"

            expect(await fake.getUser(created.id)).toMatchObject({ name: null, attributes: { company: "Acme" } })
        })
    })

    describe("findUserByEmail", () => {
        it("finds the user with that email", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")
            expect(await fake.findUserByEmail("dana@acme.co")).toEqual(user)
        })

        it("returns null when nobody has that email", async () => {
            expect(await new FakeAdapter().findUserByEmail("nobody@acme.co")).toBeNull()
        })
    })

    describe("listUsersPage", () => {
        it("pages through every user in the order they were created", async () => {
            const fake = new FakeAdapter({ pageSize: 2 })
            const emails = ["a@acme.co", "b@acme.co", "c@acme.co", "d@acme.co", "e@acme.co"]
            for(const email of emails) await createUser(fake, email)

            const pages = await allPages((cursor) => fake.listUsersPage(cursor))

            expect(pages.map((page) => page.map((user) => user.email))).toEqual([
                ["a@acme.co", "b@acme.co"],
                ["c@acme.co", "d@acme.co"],
                ["e@acme.co"],
            ])
        })

        it("returns one empty last page when there are no users", async () => {
            expect(await new FakeAdapter().listUsersPage(null)).toEqual({ items: [], nextCursor: null })
        })
    })

    describe("setPassword", () => {
        it("makes the user change a temporary password, and clears that once it's permanent", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")

            await fake.setPassword(user.id, "Their-own-1", { temporary: false })
            expect((await fake.getUser(user.id)).status).toBe("active")

            await fake.setPassword(user.id, "Temp-pass-2", { temporary: true })
            expect((await fake.getUser(user.id)).status).toBe("password_change_required")
        })

        it("leaves an SSO user federated", async () => {
            const fake = new FakeAdapter()
            const user = fake.addFederatedUser({ email: "admin@mc3.co" })

            await fake.setPassword(user.id, "Temp-pass-1", { temporary: true })

            expect((await fake.getUser(user.id)).status).toBe("federated")
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            await expect(new FakeAdapter().setPassword("nope", "x", { temporary: true })).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("setEnabled", () => {
        it("disables and re-enables a user, and repeating either is fine", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")

            await fake.setEnabled(user.id, false)
            await fake.setEnabled(user.id, false)
            expect((await fake.getUser(user.id)).enabled).toBe(false)

            await fake.setEnabled(user.id, true)
            await fake.setEnabled(user.id, true)
            expect((await fake.getUser(user.id)).enabled).toBe(true)
        })

        it("keeps the user's status while they're disabled", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")

            await fake.setEnabled(user.id, false)

            expect(await fake.getUser(user.id)).toMatchObject({ enabled: false, status: "password_change_required" })
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            await expect(new FakeAdapter().setEnabled("nope", false)).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("deleteUser", () => {
        it("removes the user, their email and their group memberships", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")
            await fake.createGroup("Admin")
            await fake.addToGroup(user.id, "Admin")

            await fake.deleteUser(user.id)

            await expect(fake.getUser(user.id)).rejects.toBeInstanceOf(UserNotFoundError)
            expect(await fake.findUserByEmail("dana@acme.co")).toBeNull()
            expect(await fake.listGroupMembersPage("Admin", null)).toEqual({ items: [], nextCursor: null })
        })

        it("frees the email for a new user", async () => {
            const fake = new FakeAdapter()
            const first = await createUser(fake, "dana@acme.co")
            await fake.deleteUser(first.id)

            const second = await createUser(fake, "dana@acme.co")

            expect(second.id).not.toBe(first.id)
        })

        it("throws UserNotFoundError for a user who is already gone", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")
            await fake.deleteUser(user.id)

            await expect(fake.deleteUser(user.id)).rejects.toEqual(new UserNotFoundError(user.id))
        })
    })

    describe("updateAttributes", () => {
        it("sets the given attributes and keeps the others", async () => {
            const fake = new FakeAdapter({ attributes: ["company", "role"] })
            const user = await fake.createUser({
                email: "dana@acme.co",
                attributes: { company: "Acme", role: "owner" },
                temporaryPassword: "Temp-pass-1",
            })

            await fake.updateAttributes(user.id, { company: "Acme Corp" })

            expect((await fake.getUser(user.id)).attributes).toEqual({ company: "Acme Corp", role: "owner" })
        })

        it("rejects an attribute its config didn't declare", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })
            const user = await createUser(fake, "dana@acme.co")

            // @ts-expect-error: undeclared attributes are a compile error; this checks the runtime guard
            await expect(fake.updateAttributes(user.id, { role: "owner" })).rejects.toThrow("Unknown attribute role")
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            const fake = new FakeAdapter({ attributes: ["company"] })
            await expect(fake.updateAttributes("nope", { company: "Acme" })).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("resendInvite", () => {
        it("records another provider invitation", async () => {
            const fake = new FakeAdapter()
            const user = await fake.createUserWithInvite({ email: "dana@acme.co" })

            await fake.resendInvite(user.id)

            expect(fake.invitations).toEqual([
                { userId: user.id, email: "dana@acme.co" },
                { userId: user.id, email: "dana@acme.co" },
            ])
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            await expect(new FakeAdapter().resendInvite("nope")).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("signOutEverywhere", () => {
        it("records each sign-out", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")

            await fake.signOutEverywhere(user.id)
            await fake.signOutEverywhere(user.id)

            expect(fake.signOuts).toEqual([user.id, user.id])
        })

        it("throws UserNotFoundError for an unknown id", async () => {
            await expect(new FakeAdapter().signOutEverywhere("nope")).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    describe("groups", () => {
        it("creates a group, and reports whether one exists", async () => {
            const fake = new FakeAdapter()
            expect(await fake.groupExists("Admin")).toBe(false)

            await fake.createGroup("Admin")

            expect(await fake.groupExists("Admin")).toBe(true)
        })

        it("throws GroupExistsError when creating a group that exists", async () => {
            const fake = new FakeAdapter()
            await fake.createGroup("Admin")
            await expect(fake.createGroup("Admin")).rejects.toEqual(new GroupExistsError("Admin"))
        })

        it("adds and removes members, and repeating either is fine", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")
            await fake.createGroup("Admin")

            await fake.addToGroup(user.id, "Admin")
            await fake.addToGroup(user.id, "Admin")
            expect((await fake.listGroupMembersPage("Admin", null)).items).toEqual([user])
            expect((await fake.listUserGroupsPage(user.id, null)).items).toEqual(["Admin"])

            await fake.removeFromGroup(user.id, "Admin")
            await fake.removeFromGroup(user.id, "Admin")
            expect((await fake.listGroupMembersPage("Admin", null)).items).toEqual([])
            expect((await fake.listUserGroupsPage(user.id, null)).items).toEqual([])
        })

        it("throws GroupNotFoundError when the group doesn't exist", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")

            await expect(fake.addToGroup(user.id, "Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(fake.removeFromGroup(user.id, "Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(fake.listGroupMembersPage("Admin", null)).rejects.toEqual(new GroupNotFoundError("Admin"))
            await expect(fake.deleteGroup("Admin")).rejects.toEqual(new GroupNotFoundError("Admin"))
        })

        it("throws UserNotFoundError when the user doesn't exist", async () => {
            const fake = new FakeAdapter()
            await fake.createGroup("Admin")

            await expect(fake.addToGroup("nope", "Admin")).rejects.toEqual(new UserNotFoundError("nope"))
            await expect(fake.removeFromGroup("nope", "Admin")).rejects.toEqual(new UserNotFoundError("nope"))
            await expect(fake.listUserGroupsPage("nope", null)).rejects.toEqual(new UserNotFoundError("nope"))
        })

        it("deleting a group removes it from its members", async () => {
            const fake = new FakeAdapter()
            const user = await createUser(fake, "dana@acme.co")
            await fake.createGroup("contractor-123")
            await fake.addToGroup(user.id, "contractor-123")

            await fake.deleteGroup("contractor-123")

            expect(await fake.groupExists("contractor-123")).toBe(false)
            expect((await fake.listUserGroupsPage(user.id, null)).items).toEqual([])
        })

        it("pages through a group's members and a user's groups", async () => {
            const fake = new FakeAdapter({ pageSize: 2 })
            const users: IdpUser[] = []
            for(const email of ["a@acme.co", "b@acme.co", "c@acme.co"]) users.push(await createUser(fake, email))
            for(const group of ["G1", "G2", "G3"]){
                await fake.createGroup(group)
                for(const user of users) await fake.addToGroup(user.id, group)
            }

            const memberPages = await allPages((cursor) => fake.listGroupMembersPage("G1", cursor))
            const groupPages = await allPages((cursor) => fake.listUserGroupsPage(users[0].id, cursor))

            expect(memberPages.map((page) => page.map((user) => user.email))).toEqual([["a@acme.co", "b@acme.co"], ["c@acme.co"]])
            expect(groupPages).toEqual([["G1", "G2"], ["G3"]])
        })
    })
})
