import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The exports map is hand-written, so check it against src/: every published subpath needs a source
// entry file, and its types and code must come from the same file.
const root = join(__dirname, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

type Entry = { types: string; default: string }
const subpaths = Object.entries(pkg.exports as Record<string, Entry | string>).filter(
    (entry): entry is [string, Entry] => typeof entry[1] !== "string",
)

describe("package exports", () => {
    it("publishes the core and every adapter subpath", () => {
        expect(subpaths.map(([subpath]) => subpath)).toEqual([".", "./cognito", "./keycloak", "./fake"])
    })

    it.each(subpaths)("%s points at a source entry file", (_subpath, entry) => {
        const source = entry.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")
        expect(existsSync(join(root, source))).toBe(true)
    })

    it.each(subpaths)("%s takes its types and code from the same file", (_subpath, entry) => {
        expect(entry.types.replace(/\.d\.ts$/, "")).toBe(entry.default.replace(/\.js$/, ""))
    })

    it("points main and types at the core entry", () => {
        expect(pkg.main).toBe(pkg.exports["."].default.replace(/^\.\//, ""))
        expect(pkg.types).toBe(pkg.exports["."].types.replace(/^\.\//, ""))
    })
})
