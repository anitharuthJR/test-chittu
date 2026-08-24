variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "vpc_id" { type = string }

variable "isolated_subnet_ids" {
  description = "The tier with no route to a NAT gateway. Passing the private subnets here would silently give the database an egress path."
  type        = list(string)
}

variable "runtime_role_arns" {
  description = "Task roles permitted to use the child-data CMK. Keep this to the API and the migration task."
  type        = list(string)
}

variable "training_role_arns" {
  description = "Explicitly DENIED on the child-data key. Empty is fine and is the dev default — the deny statement is written so that an empty list is a no-op rather than a deny-everyone."
  type        = list(string)
  default     = []
}

variable "database_name" {
  type    = string
  default = "chittu"
}

variable "master_username" {
  type    = string
  default = "chittu"
}

variable "engine_version" {
  description = "Postgres 16 — the version architecture §2.2 commits to, and the one compose.yaml runs locally."
  type        = string
  default     = "16.4"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling. 0 disables autoscaling."
  type        = number
  default     = 100
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  description = "Backups are copies of every conversation in the database; they inherit the child-data CMK. Retention is a retention-policy decision (requirements §6), not an ops preference — do not raise it without one."
  type        = number
  default     = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
