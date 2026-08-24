output "log_group_names" {
  value = { for k, g in aws_cloudwatch_log_group.app : k => g.name }
}

output "log_group_arns" {
  value = { for k, g in aws_cloudwatch_log_group.app : k => g.arn }
}

output "findings_log_group_name" {
  value = aws_cloudwatch_log_group.findings.name
}
