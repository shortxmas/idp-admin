// Adapter conformance: the one test file not paired with a source file. Every adapter runs these same
// scenarios, so passing them is what "behaves the same as the other adapters" means.
//
// Once the fake adapter exists this becomes a describe.each over a list of adapters. Adding an
// adapter means adding it to that list; adapters backed by a real provider run only when their
// provider settings are in the environment (see CONTRIBUTING.md).
//
// Each todo below becomes a test, written before the behaviour it checks.
describe("adapter conformance", () => {
    describe("users", () => {
        it.todo("creates a user and finds it by email")
        it.todo("treats emails as case-insensitive")
        it.todo("handles an email containing a quote safely")
        it.todo("throws UserExistsError when creating a duplicate")
        it.todo("returns null for a user that doesn't exist")
        it.todo("reports a user created with a temporary password as password_change_required")
        it.todo("disables and re-enables a user")
        it.todo("deletes a user")
        it.todo("lists every user across pages")
    })

    describe("groups", () => {
        it.todo("adds a user to a group and removes them")
        it.todo("ensures a group exists, idempotently")
        it.todo("lists a user's groups")
        it.todo("lists every member of a group across pages")
    })

    describe("access-reduced hook", () => {
        it.todo("fires after a user is deleted")
        it.todo("fires after a user is disabled")
        it.todo("fires after a user is removed from a group")
        it.todo("fires when deleting a user that is already gone")
    })

    describe("capabilities", () => {
        it.todo("throws NotSupportedError for a feature the adapter doesn't declare")
    })
})
