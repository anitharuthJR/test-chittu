variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "instance_type" {
  description = "arm64 only — the AMI lookup and the Mac-built image are both arm64."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  type    = number
  default = 30
}

variable "allowed_ssh_cidr" {
  description = "The ONE address allowed to SSH, as a /32 (e.g. 203.0.113.7/32). Re-apply with a new value when your IP changes; do not widen it instead."
  type        = string

  validation {
    condition     = endswith(var.allowed_ssh_cidr, "/32")
    error_message = "allowed_ssh_cidr must be a single /32 address."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key material for the ubuntu user (the .pub line, not a path)."
  type        = string
}

variable "eip_allocation_id" {
  description = "Existing Elastic IP allocation to associate (eipalloc-...). Null makes Terraform create and OWN one instead — in that mode `destroy` releases the address and the chittu.tulifo.ai A record must be repointed."
  type        = string
  default     = null
}
