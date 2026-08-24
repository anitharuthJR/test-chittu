variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "vpc_id" { type = string }

variable "public_subnet_ids" {
  description = "ALB only."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Tasks. Never the isolated tier — a task there could not pull its image."
  type        = list(string)
}

variable "image" {
  description = "Fully qualified image reference, digest-pinned in prod. A mutable tag means the task definition does not describe what is running."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. There is no HTTP-serving path — 80 only redirects."
  type        = string
}

variable "db_secret_arn" {
  description = "Secrets Manager ARN from the data module. Referenced by the task definition; its value never enters Terraform."
  type        = string
}

variable "child_data_key_arn" {
  description = "CMK the DB secret is encrypted with; the execution role needs kms:Decrypt on it to resolve the secret."
  type        = string
}

variable "provider_key_secret_arn" {
  description = "Model provider API key. Null means the service starts with no key — which main.ts REFUSES in production, deliberately, because the stub router classifies every turn SAFE."
  type        = string
  default     = null
}

variable "db_security_group_id" { type = string }

variable "log_group_name" { type = string }
variable "log_group_arn" { type = string }
variable "migrate_log_group_name" { type = string }

variable "container_port" {
  type    = number
  default = 8080
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "cpu_architecture" {
  description = "ARM64 by default — Graviton is cheaper and the image is built multi-arch."
  type        = string
  default     = "ARM64"
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "rate_limit_per_5min" {
  description = "WAF per-IP rate limit. Generous on purpose: a shared school or household NAT hitting a tight limit means 'Chittu is broken' to a nine-year-old, with no support path."
  type        = number
  default     = 3000
}

variable "tags" {
  type    = map(string)
  default = {}
}
