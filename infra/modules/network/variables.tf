variable "env" {
  description = "Environment name — dev | staging | prod. Used in every resource name."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "region" {
  description = "AWS region. Named explicitly rather than read from the provider because VPC endpoint service names embed it, and a mismatch fails at apply with a service-not-found that reads like an AWS outage."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Must be a /16 through /20: the module carves three tiers of four subnets each with cidrsubnet(.., 4, ..), which needs 12 usable /n+4 blocks."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "AZs to spread across. Two is the minimum an ALB will accept; the CIDR maths allows up to four."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 4
    error_message = "between 2 and 4 AZs — an ALB requires 2, and the derived CIDR layout has room for 4."
  }
}

variable "nat_gateway" {
  description = "Give the private tier egress to the internet. OFF by default: the API's only outbound need is the model provider, and dev has no provider key. Production sets it true."
  type        = bool
  default     = false
}

variable "flow_logs" {
  description = "VPC flow logs to CloudWatch. Metadata only — five-tuples and byte counts, never payloads."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "Flow log retention. Short by default: this is operational telemetry, not the audit trail (that is the seal chain, in Postgres)."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags applied to every resource in the module."
  type        = map(string)
  default     = {}
}
