output "alb_dns_name" {
  description = "Point a CNAME here. There is no DNS in this configuration on purpose — the zone is not ours to create."
  value       = module.api.alb_dns_name
}

output "cluster_name" { value = module.api.cluster_name }
output "service_name" { value = module.api.service_name }

output "migrate_task_definition_arn" {
  description = "Run to completion BEFORE updating the service."
  value       = module.api.migrate_task_definition_arn
}

output "db_endpoint" { value = module.data.db_endpoint }

output "findings_log_group" {
  description = "Where the data-protection policy writes a finding when a child's words reach a log group."
  value       = module.observability.findings_log_group_name
}
