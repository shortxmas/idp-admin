// Behaviour only the fake has. The IdpAdapter contract every adapter shares is tested in src/adapters.test.ts.
import type { IdpAdapter } from "../adapter"
import { UserExistsError, UserNotFoundError } from "../errors"
import { FakeAdapter } from "./index"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("FakeAdapter", () => {
    it("implements IdpAdapter with the attribute names from its config", () => {
        const adapter: IdpAdapter<"company"> = new FakeAdapter({ attributes: ["company"] })
        expect(adapter).toBeInstanceOf(FakeAdapter)
    })

    it("gives users UUID v4 ids", async () => {
        const user = await new FakeAdapter().createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
        expect(user.id).toMatch(UUID_V4)
    })

    it("lists users in the order they were created", async () => {
        const fake = new FakeAdapter({ pageSize: 2 })
        for(const email of ["c@acme.co", "a@acme.co", "b@acme.co"]) await fake.createUser({ email, temporaryPassword: "Temp-pass-1" })

        const first = await fake.listUsersPage(null)
        const second = await fake.listUsersPage(first.nextCursor)

        expect([...first.items, ...second.items].map((user) => user.email)).toEqual(["c@acme.co", "a@acme.co", "b@acme.co"])
        expect(second.nextCursor).toBeNull()
    })

    it("returns copies, so changing one doesn't change the stored user", async () => {
        const fake = new FakeAdapter({ attributes: ["company"] })
        const created = await fake.createUser({ email: "dana@acme.co", attributes: { company: "Acme" }, temporaryPassword: "Temp-pass-1" })

        const read = await fake.getUser(created.id)
        read.name = "Changed"
        read.attributes.company = "Changed"

        expect(await fake.getUser(created.id)).toMatchObject({ name: null, attributes: { company: "Acme" } })
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

    describe("invitations", () => {
        it("records none for createUser, because the app sends its own email", async () => {
            const fake = new FakeAdapter()
            await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
            expect(fake.invitations).toEqual([])
        })

        it("records one for createUserWithInvite, whose user must set a password", async () => {
            const fake = new FakeAdapter()

            const user = await fake.createUserWithInvite({ email: "dana@acme.co", name: "Dana Lee" })

            expect(user.status).toBe("password_change_required")
            expect(fake.invitations).toEqual([{ userId: user.id, email: "dana@acme.co" }])
        })

        it("records none when createUserWithInvite finds the email taken", async () => {
            const fake = new FakeAdapter()
            await fake.createUserWithInvite({ email: "dana@acme.co" })

            await expect(fake.createUserWithInvite({ email: "dana@acme.co" })).rejects.toBeInstanceOf(UserExistsError)
            expect(fake.invitations).toHaveLength(1)
        })

        it("records another for resendInvite", async () => {
            const fake = new FakeAdapter()
            const user = await fake.createUserWithInvite({ email: "dana@acme.co" })

            await fake.resendInvite(user.id)

            expect(fake.invitations).toEqual([
                { userId: user.id, email: "dana@acme.co" },
                { userId: user.id, email: "dana@acme.co" },
            ])
        })

        it("throws UserNotFoundError from resendInvite for an unknown id", async () => {
            await expect(new FakeAdapter().resendInvite("nope")).rejects.toBeInstanceOf(UserNotFoundError)
        })
    })

    it("records each signOutEverywhere", async () => {
        const fake = new FakeAdapter()
        const user = await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })

        await fake.signOutEverywhere(user.id)
        await fake.signOutEverywhere(user.id)

        expect(fake.signOuts).toEqual([user.id, user.id])
    })

    describe("addFederatedUser", () => {
        it("adds an SSO user, synchronously, with any declared attributes", () => {
            const fake = new FakeAdapter({ attributes: ["company"] })

            const user = fake.addFederatedUser({ email: "admin@mc3.co", name: "An Admin", attributes: { company: "MC3" } })

            expect(user).toMatchObject({ email: "admin@mc3.co", name: "An Admin", status: "federated", attributes: { company: "MC3" } })
        })

        it("throws UserExistsError for an email that's taken", () => {
            const fake = new FakeAdapter()
            fake.addFederatedUser({ email: "admin@mc3.co" })
            expect(() => fake.addFederatedUser({ email: "admin@mc3.co" })).toThrow(UserExistsError)
        })
    })

    describe("requirePasswordReset", () => {
        it("puts a user into password_reset_required, as an admin reset at a real provider would", async () => {
            const fake = new FakeAdapter()
            const user = await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
            await fake.setPassword(user.id, "Their-own-1!", { temporary: false })

            fake.requirePasswordReset(user.id)

            expect((await fake.getUser(user.id)).status).toBe("password_reset_required")
        })

        it("is cleared by setting a password", async () => {
            const fake = new FakeAdapter()
            const user = await fake.createUser({ email: "dana@acme.co", temporaryPassword: "Temp-pass-1" })
            fake.requirePasswordReset(user.id)

            await fake.setPassword(user.id, "Their-own-1!", { temporary: false })

            expect((await fake.getUser(user.id)).status).toBe("active")
        })

        it("leaves a federated user federated, because they sign in elsewhere", async () => {
            const fake = new FakeAdapter()
            const user = fake.addFederatedUser({ email: "admin@mc3.co" })

            fake.requirePasswordReset(user.id)

            expect((await fake.getUser(user.id)).status).toBe("federated")
        })

        it("throws UserNotFoundError for an unknown id", () => {
            expect(() => new FakeAdapter().requirePasswordReset("nope")).toThrow(UserNotFoundError)
        })
    })
})
