// Throwaway realms for the Keycloak tests, created and deleted through the master realm's admin API.
// Used only by tests; tsconfig.build.json leaves it out of the package.
import { randomUUID } from "node:crypto"

export const KEYCLOAK_TEST_URL = process.env.KEYCLOAK_TEST_URL?.replace(/\/+$/, "")
const ADMIN_USER = process.env.KEYCLOAK_TEST_ADMIN_USER ?? "admin"
const ADMIN_PASSWORD = process.env.KEYCLOAK_TEST_ADMIN_PASSWORD ?? "admin"

/** The realm-management roles the adapter's service account needs; see docs/keycloak.md. */
export const ADAPTER_ROLES = ["manage-users", "view-users", "query-users", "query-groups", "manage-realm"]

const CLIENT_ID = "idp-admin"
const CLIENT_SECRET = "idp-admin-test-secret"
const LOGIN_CLIENT_ID = "test-login"

function baseUrl(){
    if(!KEYCLOAK_TEST_URL) throw new Error("KEYCLOAK_TEST_URL is not set; see CONTRIBUTING.md")
    return KEYCLOAK_TEST_URL
}

async function form(url: string, body: Record<string, string>){
    return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
    })
}

async function masterToken(){
    const response = await form(`${baseUrl()}/realms/master/protocol/openid-connect/token`, {
        grant_type: "password",
        client_id: "admin-cli",
        username: ADMIN_USER,
        password: ADMIN_PASSWORD,
    })
    if(!response.ok) throw new Error(`Keycloak master admin login failed (${response.status}): ${await response.text()}`)
    return ((await response.json()) as { access_token: string }).access_token
}

export type TestRealmOptions = {
    // realm-management roles granted to the adapter's service account
    roles?: string[]
    // let users have attributes the realm's user profile doesn't declare
    unmanagedAttributes?: boolean
}

export type TestRealm = Awaited<ReturnType<typeof createTestRealm>>

/**
 * A new realm with a confidential client whose service account has `roles`, plus a public client
 * for password sign-in. Call `delete()` when done.
 */
export async function createTestRealm(options: TestRealmOptions = {}){
    const realm = `idp-admin-${randomUUID()}`
    const token = await masterToken()

    /** A master-admin call; paths are relative to /admin/realms. Throws on any status but 2xx. */
    async function admin<T = unknown>(method: string, path: string, body?: unknown): Promise<{ json: T; location: string | null }>{
        const response = await fetch(`${baseUrl()}/admin/realms${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if(!response.ok) throw new Error(`test realm setup: ${method} ${path} failed (${response.status}): ${await response.text()}`)
        const text = await response.text()
        return { json: (text ? JSON.parse(text) : undefined) as T, location: response.headers.get("location") }
    }

    await admin("POST", "", { realm, enabled: true })
    const r = `/${realm}`
    await admin("POST", `${r}/clients`, {
        clientId: CLIENT_ID, secret: CLIENT_SECRET, publicClient: false,
        serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
    })
    await admin("POST", `${r}/clients`, { clientId: LOGIN_CLIENT_ID, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: false })

    const [client] = (await admin<{ id: string }[]>("GET", `${r}/clients?clientId=${CLIENT_ID}`)).json
    const serviceAccount = (await admin<{ id: string }>("GET", `${r}/clients/${client.id}/service-account-user`)).json
    const [realmManagement] = (await admin<{ id: string }[]>("GET", `${r}/clients?clientId=realm-management`)).json
    const available = (await admin<{ id: string; name: string }[]>("GET", `${r}/clients/${realmManagement.id}/roles`)).json
    const wanted = new Set(options.roles ?? ADAPTER_ROLES)
    const grant = available.filter((role) => wanted.has(role.name)).map(({ id, name }) => ({ id, name }))
    if(grant.length) await admin("POST", `${r}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`, grant)

    if(options.unmanagedAttributes ?? true){
        const profile = (await admin<Record<string, unknown>>("GET", `${r}/users/profile`)).json
        await admin("PUT", `${r}/users/profile`, { ...profile, unmanagedAttributePolicy: "ENABLED" })
    }

    let federationReady = false

    return {
        realm,
        issuer: `${baseUrl()}/realms/${realm}`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        admin: (method: string, path: string, body?: unknown) => admin(method, `${r}${path}`, body),

        /** Adds a user linked to an external identity provider, as a first SSO sign-in would. Returns their id. */
        async addFederatedUser(email: string){
            if(!federationReady){
                await admin("POST", `${r}/identity-provider/instances`, {
                    alias: "sso", providerId: "oidc", enabled: true,
                    config: { clientId: "x", clientSecret: "y", authorizationUrl: "https://idp.example/auth", tokenUrl: "https://idp.example/token" },
                })
                federationReady = true
            }
            const { location } = await admin("POST", `${r}/users`, { username: email, email, enabled: true, emailVerified: true })
            const id = location!.split("/").pop()!
            await admin("POST", `${r}/users/${id}/federated-identity/sso`, { identityProvider: "sso", userId: `sso-${id}`, userName: email })
            return id
        },

        /** Signs in with a password through the public client; the tokens, or the error Keycloak returned. */
        async signIn(username: string, password: string){
            const response = await form(`${baseUrl()}/realms/${realm}/protocol/openid-connect/token`, {
                grant_type: "password", client_id: LOGIN_CLIENT_ID, username, password, scope: "openid",
            })
            return (await response.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string }
        },

        /** Exchanges a refresh token; the error Keycloak returned, or null if it still worked. */
        async refresh(refreshToken: string){
            const response = await form(`${baseUrl()}/realms/${realm}/protocol/openid-connect/token`, {
                grant_type: "refresh_token", client_id: LOGIN_CLIENT_ID, refresh_token: refreshToken,
            })
            return response.ok ? null : ((await response.json()) as { error: string }).error
        },

        async delete(){
            await admin("DELETE", r)
        },
    }
}
