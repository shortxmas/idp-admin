import {
    AccessReductionIncompleteError,
    type AnyIdpAdminError,
    GroupExistsError,
    GroupNotFoundError,
    IdpAdminError,
    NotSupportedError,
    UserExistsError,
    UserNotFoundError,
} from "./errors"

describe("errors", () => {
    it.each([
        [new UserNotFoundError("u-1"), UserNotFoundError, "USER_NOT_FOUND"],
        [new UserExistsError("a@b.co"), UserExistsError, "USER_EXISTS"],
        [new GroupNotFoundError("Admin"), GroupNotFoundError, "GROUP_NOT_FOUND"],
        [new GroupExistsError("Admin"), GroupExistsError, "GROUP_EXISTS"],
        [new NotSupportedError("resendInvite"), NotSupportedError, "NOT_SUPPORTED"],
    ] as const)("%s has its own class, a fixed code and its class name", (error, Class, code) => {
        expect(error).toBeInstanceOf(Class)
        expect(error).toBeInstanceOf(IdpAdminError)
        expect(error).toBeInstanceOf(Error)
        expect(error.code).toBe(code)
        expect(error.name).toBe(Class.name)
    })

    it("carries what was missing or already there", () => {
        expect(new UserNotFoundError("u-1")).toMatchObject({ userId: "u-1", message: "No user with id u-1" })
        expect(new UserExistsError("a@b.co")).toMatchObject({ email: "a@b.co", message: "A user with email a@b.co already exists" })
        expect(new GroupNotFoundError("Admin")).toMatchObject({ group: "Admin", message: "No group named Admin" })
        expect(new GroupExistsError("Admin")).toMatchObject({ group: "Admin", message: "A group named Admin already exists" })
        expect(new NotSupportedError("resendInvite")).toMatchObject({
            feature: "resendInvite",
            message: "This adapter doesn't support resendInvite",
        })
    })

    it("says which access reduction stopped part way, at which step, and why", () => {
        const cause = new Error("database unreachable")
        const error = new AccessReductionIncompleteError({ userId: "u-1", action: "disabled", failedStep: "hook", cause })

        expect(error).toBeInstanceOf(IdpAdminError)
        expect(error).toMatchObject({
            code: "ACCESS_REDUCTION_INCOMPLETE",
            name: "AccessReductionIncompleteError",
            userId: "u-1",
            action: "disabled",
            failedStep: "hook",
            cause,
        })
        expect(error.message).toBe(
            "User u-1 was disabled at the provider, but the access-reduced hook failed: database unreachable. " +
            "Calling the same method again is safe and retries it.",
        )
    })

    it("names the provider sign-out step when that is what failed", () => {
        const error = new AccessReductionIncompleteError({
            userId: "u-1",
            action: "removed-from-group",
            failedStep: "provider-sign-out",
            cause: "throttled",
        })

        expect(error.message).toBe(
            "User u-1 was removed from a group at the provider, but signing them out at the provider failed: throttled. " +
            "Calling the same method again is safe and retries it.",
        )
    })

    it("names the group a user was removed from", () => {
        const error = new AccessReductionIncompleteError({ userId: "u-1", action: "removed-from-group", group: "Admin", failedStep: "hook", cause: "db down" })

        expect(error.group).toBe("Admin")
        expect(error.message).toBe(
            "User u-1 was removed from group Admin at the provider, but the access-reduced hook failed: db down. " +
            "Calling the same method again is safe and retries it.",
        )
    })

    it("gives the recovery for a group deletion that stopped part way", () => {
        const error = new AccessReductionIncompleteError({
            userId: "u-1", action: "removed-from-group", group: "Admin", failedStep: "hook", cause: "db down", deletingGroup: true,
        })

        expect(error.message).toBe(
            "User u-1 was removed from group Admin at the provider, but the access-reduced hook failed: db down. " +
            "The group wasn't deleted. Call removeFromGroup for this user and group, then deleteGroup again.",
        )
    })

    it("lets a switch on code narrow to the matching error", () => {
        const describe = (error: AnyIdpAdminError) => {
            switch(error.code){
                case "USER_NOT_FOUND": return error.userId
                case "GROUP_NOT_FOUND": return error.group
                default: return null
            }
        }
        expect(describe(new UserNotFoundError("u-1"))).toBe("u-1")
        expect(describe(new GroupNotFoundError("Admin"))).toBe("Admin")
    })
})
