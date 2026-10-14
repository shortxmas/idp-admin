import { randomInt } from "node:crypto"

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const LOWER = "abcdefghijklmnopqrstuvwxyz"
const DIGITS = "0123456789"
// a subset every provider accepts, and that needs no escaping in an email or a URL
const SYMBOLS = "!@#$%^&*"
const ALL = UPPER + LOWER + DIGITS + SYMBOLS

export type TemporaryPasswordOptions = {
    // a whole number from 8 to 256; defaults to 16
    length?: number
}

/**
 * A random temporary password for `createUser` or `setPassword`, from Node's cryptographic random
 * source. It always has at least one uppercase letter, lowercase letter, digit and symbol, so default
 * password policies accept it, and is 16 characters unless `length` says otherwise. A provider policy
 * stricter than that (a longer minimum, say) needs a matching `length`.
 */
export function generateTemporaryPassword(options: TemporaryPasswordOptions = {}): string{
    const length = options.length ?? 16
    if(!Number.isInteger(length) || length < 8 || length > 256){
        throw new RangeError(`A temporary password's length must be a whole number from 8 to 256, not ${length}`)
    }
    const characters = [UPPER, LOWER, DIGITS, SYMBOLS].map(pick)
    while(characters.length < length) characters.push(pick(ALL))
    // shuffle, so the guaranteed characters aren't always first
    for(let i = characters.length - 1; i > 0; i--){
        const j = randomInt(i + 1)
        const swapped = characters[i]
        characters[i] = characters[j]
        characters[j] = swapped
    }
    return characters.join("")
}

function pick(from: string): string{
    return from[randomInt(from.length)]
}
