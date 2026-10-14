# An IAM user for the idp-admin Cognito tests, which create throwaway user pools, run against them and
# delete them. It can't touch any user pool it didn't create: every action on a pool requires the pool's
# test tag, and the only pools it can create are ones carrying that tag. Its access keys are created
# outside Terraform so the secret never lands in state; see README.md.

data "aws_caller_identity" "current" {}

locals {
  user_pools = "arn:aws:cognito-idp:${var.region}:${data.aws_caller_identity.current.account_id}:userpool/*"

  # The only tags a test pool may have: the test tag, and when it was created, so a later run can
  # delete pools an interrupted run left behind.
  allowed_tag_keys = [var.pool_tag_key, "created-at"]
}

resource "aws_iam_user" "cognito_tests" {
  name = var.user_name
  path = "/ci/"
}

data "aws_iam_policy_document" "cognito_tests" {
  # Create user pools, only with the test tag and no other tags but created-at.
  statement {
    sid       = "CreateTestPools"
    actions   = ["cognito-idp:CreateUserPool"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/${var.pool_tag_key}"
      values   = [var.pool_tag_value]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.allowed_tag_keys
    }
    # without this, a request with no tags at all would pass the ForAllValues check above
    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  # Tagging, in case creating a tagged pool needs it. Limited to pools that already carry the test tag,
  # so it can't be used to mark someone else's pool as a test pool and then manage it.
  statement {
    sid       = "TagTestPools"
    actions   = ["cognito-idp:TagResource"]
    resources = [local.user_pools]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/${var.pool_tag_key}"
      values   = [var.pool_tag_value]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/${var.pool_tag_key}"
      values   = [var.pool_tag_value]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.allowed_tag_keys
    }
    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  # Everything the adapter and the tests do inside a test pool, and deleting it afterwards.
  statement {
    sid = "UseTestPools"
    actions = [
      # the adapter
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:ListUsersInGroup",
      "cognito-idp:GetGroup",
      "cognito-idp:CreateGroup",
      "cognito-idp:DeleteGroup",
      "cognito-idp:DescribeUserPool",
      # the tests: sign a user in to check their token's sub and that sign-out revokes it, empty a
      # pool between tests, read tags to find pools left behind, and delete pools
      "cognito-idp:CreateUserPoolClient",
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:ListGroups",
      "cognito-idp:ListTagsForResource",
      "cognito-idp:DeleteUserPool",
    ]
    resources = [local.user_pools]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/${var.pool_tag_key}"
      values   = [var.pool_tag_value]
    }
  }

  # Listing pool ids and names, to find test pools an interrupted run left behind. ListUserPools has no
  # resource to scope it to; it reveals names, not contents.
  statement {
    sid       = "ListPools"
    actions   = ["cognito-idp:ListUserPools"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }
}

resource "aws_iam_user_policy" "cognito_tests" {
  name   = "cognito-test-pools"
  user   = aws_iam_user.cognito_tests.name
  policy = data.aws_iam_policy_document.cognito_tests.json
}
