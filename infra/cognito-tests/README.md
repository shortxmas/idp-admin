# Cognito test credentials

Terraform for the IAM user whose static access keys the Cognito adapter tests use, locally and in CI.

The tests create a throwaway user pool per test file, run against it and delete it. The user can't touch any user pool it didn't create:

- it can create user pools only if they carry the tag `idp-admin = test-pool` (and optionally `created-at`), in one region
- every other action, including deleting a pool, works only on pools carrying that tag
- it can tag only pools that already carry the test tag, so it can't mark someone else's pool as a test pool
- the one unscoped action is `ListUserPools`, which shows pool ids and names, used to find pools an interrupted run left behind

It has no permissions outside Cognito user pools.

## Apply

```sh
terraform init
terraform apply                 # -var region=us-west-2 for another region
```

State is local by default. Add a backend if more than one person applies this.

## Create the access keys

Keys are created outside Terraform so the secret never lands in Terraform state:

```sh
aws iam create-access-key --user-name "$(terraform output -raw user_name)"
```

Then put them where the tests read them:

| Where | Settings |
|---|---|
| GitHub repository secrets | `COGNITO_TEST_AWS_ACCESS_KEY_ID`, `COGNITO_TEST_AWS_SECRET_ACCESS_KEY`, and `COGNITO_TEST_REGION` (`terraform output -raw region`) |
| Local `.env` (gitignored) | the same three variables |

Without them, the Cognito tests are skipped. Pull requests from forks never get repository secrets, so they skip the Cognito tests too.

## Rotating

```sh
aws iam create-access-key --user-name idp-admin-cognito-tests     # update the secrets with the new key
aws iam delete-access-key --user-name idp-admin-cognito-tests --access-key-id <old key id>
```

## To confirm on the first run

`TagResource` is granted in case creating a tagged pool needs it, limited to pools that already carry the test tag. If the first test run creates pools without it, it can be removed.
