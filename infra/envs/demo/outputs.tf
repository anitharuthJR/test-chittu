output "instance_id" {
  value = aws_instance.demo.id
}

output "public_ip" {
  description = "The address chittu.tulifo.ai must point at (A record, TTL 600, at GoDaddy)."
  value       = local.eip_public_ip
}

output "ssh" {
  value = "ssh ubuntu@${local.eip_public_ip}"
}

output "url" {
  description = "Serves after the runbook's ship + compose + Caddy steps (§4-§6)."
  value       = "https://chittu.tulifo.ai"
}
