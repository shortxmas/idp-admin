/**
 * Where a user is in their account lifecycle. Whether they can sign in is separate: see `IdpUser.enabled`.
 *
 * - `active`: has a permanent password, or otherwise needs nothing before signing in
 * - `password_change_required`: has a temporary password and must set their own at next sign-in
 * - `federated`: signs in through another identity provider (SSO), so has no password here
 * - `unconfirmed`: signed themselves up and hasn't confirmed their account yet
 */
export type UserStatus = "active" | "password_change_required" | "federated" | "unconfirmed"

/**
 * Custom attributes, keyed by the names the app declared in its adapter's config. Values are strings,
 * because that is what providers store; convert other types yourself. With none declared, no key is
 * allowed (an empty `{}` type would accept any key).
 */
export type UserAttributes<TAttr extends string> = [TAttr] extends [never] ? Record<string, never> : Partial<Record<TAttr, string>>

/** A user as every adapter reports them. */
export type IdpUser<TAttr extends string = never> = {
    // the provider's permanent id for the user, the one their sign-in tokens carry as `sub`
    id: string
    // always lowercase
    email: string
    name: string | null
    status: UserStatus
    // false once disabled: the user can't sign in, whatever their status
    enabled: boolean
    attributes: UserAttributes<TAttr>
}

/** One page of a list, and where the next one starts. */
export type Page<T> = {
    items: T[]
    // pass back to get the next page; null on the last page
    nextCursor: string | null
}
