/**
 * NOTHING HERE EXPOSES THE PASSWORD OR THE CONNECTION URL.
 *
 * The API receives DATABASE_URL by referencing the Secrets Manager ARN in its
 * task definition, so the value is resolved by ECS at task start and never
 * passes through a Terraform output, a plan file, or a CI log.
 */

output "db_secret_arn" {
  description = "Secrets Manager ARN holding username/password/host/url. Referenced by the task definition; never read by Terraform."
  value       = aws_secretsmanager_secret.db.arn
}

output "db_endpoint" {
  description = "host:port. Not a credential."
  value       = aws_db_instance.this.endpoint
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "child_data_key_arn" {
  description = "The CMK that encrypts child data at rest. Training roles are denied on it."
  value       = aws_kms_key.child_data.arn
}

output "training_key_arn" {
  description = "A DIFFERENT key, for synthetic corpora. Separate on purpose — see main.tf."
  value       = aws_kms_key.training.arn
}
