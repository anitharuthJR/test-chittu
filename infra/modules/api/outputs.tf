output "alb_dns_name" {
  description = "Point the public DNS record at this."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "task_security_group_id" {
  description = "Pass to the data module so Postgres accepts connections from these tasks and nothing else."
  value       = aws_security_group.tasks.id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "migrate_task_definition_arn" {
  description = "Run this to completion BEFORE updating the service — see the module header and docs/runbooks."
  value       = aws_ecs_task_definition.migrate.arn
}
