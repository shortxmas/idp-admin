import { generateTemporaryPassword } from "./passwords"

const UPPER = /[A-Z]/
const LOWER = /[a-z]/
const DIGIT = /[0-9]/
const SYMBOL = /[!@#$%^&*]/
const ALLOWED = /^[A-Za-z0-9!@#$%^&*]+$/

describe("generateTemporaryPassword", () => {
    it("is 16 characters by default", () => {
        expect(generateTemporaryPassword()).toHaveLength(16)
    })

    it("takes a length from 8 to 256", () => {
        expect(generateTemporaryPassword({ length: 8 })).toHaveLength(8)
        expect(generateTemporaryPassword({ length: 256 })).toHaveLength(256)
    })

    it.each([7, 257, 12.5, Number.NaN])("throws a RangeError for a length of %s", (length) => {
        expect(() => generateTemporaryPassword({ length })).toThrow(RangeError)
    })

    it("always has an uppercase letter, a lowercase letter, a digit and a symbol, so default password policies accept it", () => {
        for(let i = 0; i < 2000; i++){
            const password = generateTemporaryPassword({ length: 8 })
            expect(password).toMatch(UPPER)
            expect(password).toMatch(LOWER)
            expect(password).toMatch(DIGIT)
            expect(password).toMatch(SYMBOL)
        }
    })

    it("uses only letters, digits and symbols every provider accepts", () => {
        for(let i = 0; i < 200; i++) expect(generateTemporaryPassword()).toMatch(ALLOWED)
    })

    it("doesn't always put the guaranteed characters in the same places", () => {
        const firsts = new Set(Array.from({ length: 200 }, () => kind(generateTemporaryPassword({ length: 8 })[0])))

        expect(firsts.size).toBe(4)
    })

    it("differs every time", () => {
        const passwords = new Set(Array.from({ length: 1000 }, () => generateTemporaryPassword()))

        expect(passwords.size).toBe(1000)
    })
})

function kind(character: string): string{
    return [UPPER, LOWER, DIGIT, SYMBOL].findIndex((pattern) => pattern.test(character)).toString()
}
