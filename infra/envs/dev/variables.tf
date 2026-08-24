variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "cidr_block" {
  type    = string
  default = "10.20.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

variable "image" {
  description = "chittu-api image. Digest-pinned in staging and prod; a tag is tolerable in dev."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. There is no HTTP-serving path."
  type        = string
}

variable "provider_key_secret_arn" {
  description = "Secrets Manager ARN for ANTHROPIC_API_KEY. Null means the service REFUSES to start, because the image runs NODE_ENV=production and main.ts will not serve children through the stub router."
  type        = string
  default     = null
}
