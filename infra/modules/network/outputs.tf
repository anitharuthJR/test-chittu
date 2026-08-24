output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "ALB only."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "ECS tasks."
  value       = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  description = "Database. No route to a NAT gateway exists for these — see main.tf."
  value       = aws_subnet.isolated[*].id
}

output "has_egress" {
  description = "Whether the private tier can reach the internet. The api module refuses to configure a live provider without it, rather than deploying something that times out on its first real turn."
  value       = var.nat_gateway
}
