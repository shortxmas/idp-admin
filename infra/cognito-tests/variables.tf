variable "region" {
  description = "The only region the test user may create and use user pools in."
  type        = string
  default     = "us-east-1"
}

variable "user_name" {
  description = "Name of the IAM user whose access keys the Cognito tests use, locally and in CI."
  type        = string
  default     = "idp-admin-cognito-tests"
}

variable "pool_tag_key" {
  description = "Tag every test user pool carries. The user can create pools only with it, and touch only pools that have it."
  type        = string
  default     = "idp-admin"
}

variable "pool_tag_value" {
  description = "Value of pool_tag_key on test user pools."
  type        = string
  default     = "test-pool"
}
