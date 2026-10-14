// Throwaway Cognito user pools for the Cognito tests: one per test file, emptied between tests. Uses
// only the COGNITO_TEST_* keys of the IAM user in infra/cognito-tests, never other AWS credentials.
// Used only by tests; tsconfig.build.json leaves it out of the package.
import {
    AdminDeleteUserCommand,
    AdminInitiateAuthCommand,
    CognitoIdentityProviderClient,
    CreateUserPoolClientCommand,
    CreateUserPoolCommand,
    DeleteGroupCommand,
    DeleteUserPoolCommand,
    ListTagsForResourceCommand,
    paginateListGroups,
    paginateListUserPools,
    paginateListUsers,
} from "@aws-sdk/client-cognito-identity-provider"

const REGION = process.env.COGNITO_TEST_REGION
const ACCESS_KEY_ID = process.env.COGNITO_TEST_AWS_ACCESS_KEY_ID
const SECRET_ACCESS_KEY = process.env.COGNITO_TEST_AWS_SECRET_ACCESS_KEY

/** Why the Cognito tests can't run, or null when they can. */
export const COGNITO_TEST_SKIP = REGION && ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? null
    : "set COGNITO_TEST_AWS_ACCESS_KEY_ID, COGNITO_TEST_AWS_SECRET_ACCESS_KEY and COGNITO_TEST_REGION to run (see infra/cognito-tests)"

// infra/cognito-tests lets the test user touch only pools with this tag
const POOL_TAG = { "idp-admin": "test-pool" }
// test pools older than this were left by an interrupted run
const STALE_AFTER_MS = 60 * 60 * 1000
const PASSWORD = "Their-own-1!"

export function testClient(){
    return new CognitoIdentityProviderClient({
        region: REGION,
        credentials: { accessKeyId: ACCESS_KEY_ID!, secretAccessKey: SECRET_ACCESS_KEY! },
    })
}

export type TestPool = Awaited<ReturnType<typeof createTestPool>>

/**
 * A new user pool set up the way MC3's are: email is the username, case-insensitively, with the custom
 * attributes companyName and role. Also deletes test pools an interrupted run left behind.
 */
export async function createTestPool(){
    const client = testClient()
    const { UserPool } = await client.send(new CreateUserPoolCommand({
        PoolName: `idp-admin-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        UsernameAttributes: ["email"],
        UsernameConfiguration: { CaseSensitive: false },
        Schema: [
            { Name: "companyName", AttributeDataType: "String", Mutable: true },
            { Name: "role", AttributeDataType: "String", Mutable: true },
        ],
        UserPoolTags: { ...POOL_TAG, "created-at": new Date().toISOString() },
    }))
    const userPoolId = UserPool!.Id!
    // after creating this run's pool, whose ARN gives the account: the test user can't call STS
    await deleteStalePools(client, UserPool!.Arn!.split(":")[4])
    let appClientId: string | undefined

    return {
        client,
        userPoolId,

        /** Deletes every user and group, so the next test starts with an empty pool. */
        async empty(){
            for await (const page of paginateListUsers({ client }, { UserPoolId: userPoolId })){
                for(const user of page.Users ?? []) await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: user.Username }))
            }
            for await (const page of paginateListGroups({ client }, { UserPoolId: userPoolId })){
                for(const group of page.Groups ?? []) await client.send(new DeleteGroupCommand({ UserPoolId: userPoolId, GroupName: group.GroupName }))
            }
        },

        /** Signs a user in through an app client the pool gets on first use; their tokens. */
        async signIn(email: string, password: string = PASSWORD){
            appClientId ??= (await client.send(new CreateUserPoolClientCommand({
                UserPoolId: userPoolId,
                ClientName: "tests",
                ExplicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
            }))).UserPoolClient!.ClientId!
            const { AuthenticationResult } = await client.send(new AdminInitiateAuthCommand({
                UserPoolId: userPoolId,
                ClientId: appClientId,
                AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
                AuthParameters: { USERNAME: email, PASSWORD: password },
            }))
            return AuthenticationResult!
        },

        /** Exchanges a refresh token; the error's name, or null if it still worked. */
        async refresh(refreshToken: string){
            try{
                await client.send(new AdminInitiateAuthCommand({
                    UserPoolId: userPoolId,
                    ClientId: appClientId,
                    AuthFlow: "REFRESH_TOKEN_AUTH",
                    AuthParameters: { REFRESH_TOKEN: refreshToken },
                }))
                return null
            }catch(error){
                return (error as Error).name
            }
        },

        async delete(){
            await client.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }))
        },
    }
}

export const TEST_PASSWORD = PASSWORD

async function deleteStalePools(client: CognitoIdentityProviderClient, account: string){
    for await (const page of paginateListUserPools({ client }, { MaxResults: 60 })){
        for(const pool of page.UserPools ?? []){
            if(!pool.Name?.startsWith("idp-admin-test-")) continue
            const arn = `arn:aws:cognito-idp:${REGION}:${account}:userpool/${pool.Id}`
            // a pool the test user may not read the tags of isn't a test pool
            const tags = await client.send(new ListTagsForResourceCommand({ ResourceArn: arn })).then((r) => r.Tags ?? {}, () => ({}) as Record<string, string>)
            const createdAt = Date.parse(tags["created-at"] ?? "")
            if(tags["idp-admin"] === POOL_TAG["idp-admin"] && Date.now() - createdAt > STALE_AFTER_MS){
                await client.send(new DeleteUserPoolCommand({ UserPoolId: pool.Id })).catch(() => {})
            }
        }
    }
}
