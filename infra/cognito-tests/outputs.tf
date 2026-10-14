output "user_name" {
  description = "The IAM user to create access keys for; see README.md."
  value       = aws_iam_user.cognito_tests.name
}

output "user_arn" {
  value = aws_iam_user.cognito_tests.arn
}

output "region" {
  description = "Set as COGNITO_TEST_REGION for the tests."
  value       = var.region
}

output "pool_tag" {
  description = "The tag the tests must put on every user pool they create."
  value       = { (var.pool_tag_key) = var.pool_tag_value }
}
