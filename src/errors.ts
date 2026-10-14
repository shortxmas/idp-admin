/** Every error idp-admin throws on purpose extends this, so `instanceof IdpAdminError` separates them from provider and network failures. */
export abstract class IdpAdminError extends Error{
    abstract readonly code: string

    constructor(message: string, options?: ErrorOptions){
        super(message, options)
        this.name = new.target.name
    }
}

/** The user doesn't exist, or no longer does. */
export class UserNotFoundError extends IdpAdminError{
    readonly code = "USER_NOT_FOUND"

    constructor(readonly userId: string){
        super(`No user with id ${userId}`)
    }
}

/** A user with this email already exists. */
export class UserExistsError extends IdpAdminError{
    readonly code = "USER_EXISTS"

    constructor(readonly email: string){
        super(`A user with email ${email} already exists`)
    }
}

/** The group doesn't exist. */
export class GroupNotFoundError extends IdpAdminError{
    readonly code = "GROUP_NOT_FOUND"

    constructor(readonly group: string){
        super(`No group named ${group}`)
    }
}

/** A group with this name already exists. */
export class GroupExistsError extends IdpAdminError{
    readonly code = "GROUP_EXISTS"

    constructor(readonly group: string){
        super(`A group named ${group} already exists`)
    }
}

/** The adapter in use can't do this; `feature` is the method or option that was asked for. */
export class NotSupportedError extends IdpAdminError{
    readonly code = "NOT_SUPPORTED"

    constructor(readonly feature: string){
        super(`This adapter doesn't support ${feature}`)
    }
}

/** What happened at the provider before a later step failed. */
export type AccessReductionAction = "deleted" | "disabled" | "removed-from-group"

/** The step after the provider change that failed. */
export type AccessReductionStep = "provider-sign-out" | "hook"

const ACTION_TEXT: Record<AccessReductionAction, string> = {
    "deleted": "deleted",
    "disabled": "disabled",
    "removed-from-group": "removed from a group",
}

const STEP_TEXT: Record<AccessReductionStep, string> = {
    "provider-sign-out": "signing them out at the provider failed",
    "hook": "the access-reduced hook failed",
}

/**
 * The provider change happened, but a step after it didn't, so the user may still have live sessions
 * or provider tokens. The provider change is not undone. Calling the same method again is safe: it
 * repeats every step. The exception is `deleteGroup`, which stops at the member whose step failed and
 * leaves the group in place: call `removeFromGroup` for that member and group, then `deleteGroup` again.
 */
export class AccessReductionIncompleteError extends IdpAdminError{
    readonly code = "ACCESS_REDUCTION_INCOMPLETE"
    readonly userId: string
    readonly action: AccessReductionAction
    // the group the user was removed from, for `removed-from-group`
    readonly group: string | undefined
    readonly failedStep: AccessReductionStep

    constructor(details: {
        userId: string
        action: AccessReductionAction
        group?: string
        failedStep: AccessReductionStep
        cause: unknown
        // thrown by deleteGroup, which needs a different recovery
        deletingGroup?: boolean
    }){
        const reason = details.cause instanceof Error ? details.cause.message : String(details.cause)
        const action = details.action === "removed-from-group" && details.group !== undefined
            ? `removed from group ${details.group}`
            : ACTION_TEXT[details.action]
        const recovery = details.deletingGroup
            ? "The group wasn't deleted. Call removeFromGroup for this user and group, then deleteGroup again."
            : "Calling the same method again is safe and retries it."
        super(`User ${details.userId} was ${action} at the provider, but ${STEP_TEXT[details.failedStep]}: ${reason}. ${recovery}`, { cause: details.cause })
        this.userId = details.userId
        this.action = details.action
        this.group = details.group
        this.failedStep = details.failedStep
    }
}

/** Every idp-admin error, as a union, so `switch(error.code)` narrows to the matching class. */
export type AnyIdpAdminError =
    | UserNotFoundError
    | UserExistsError
    | GroupNotFoundError
    | GroupExistsError
    | NotSupportedError
    | AccessReductionIncompleteError
