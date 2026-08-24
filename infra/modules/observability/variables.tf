variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "log_groups" {
  description = "Service names to create groups for. Each gets the same data protection policy — a group without one is a group a child's words could sit in."
  type        = list(string)
  default     = ["api", "migrate"]
}

variable "retention_in_days" {
  description = "Operational telemetry retention. NOT the audit trail — that is the seal chain in Postgres and is governed by requirements §6."
  type        = number
  default     = 30
}

variable "kms_key_arn" {
  description = "CMK for the log groups at rest. Null uses the CloudWatch service key."
  type        = string
  default     = null
}

variable "alarm_topic_arn" {
  description = "SNS topic for the redaction-finding alarm. Null skips the alarm — acceptable in dev, not in prod (the env module enforces that)."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
