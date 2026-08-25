/**
 * The demo box — chittu.tulifo.ai. ONE EC2 instance running the compose stack
 * from deploy/demo/, behind Caddy. See docs/runbooks/demo-deploy.md.
 *
 * THIS IS NOT THE PRODUCTION PATH and shares nothing with it: no modules from
 * ../../modules (those describe Fargate + ALB + RDS), no remote state, no KMS.
 * It exists so the demo rig is reproducible and disposable. Everything secret
 * on the box (CHITTU_DEV_MASTER_KEY, the provider key, the Caddy password
 * hash) lives in on-box files created by the runbook — none of it passes
 * through Terraform, which is what makes local state acceptable here.
 *
 * THE ELASTIC IP HAS TWO MODES, because chittu.tulifo.ai's A record points at
 * a fixed address and the record outlives any one instance:
 *
 *   eip_allocation_id set   -> an EXISTING, hand-allocated EIP is looked up
 *                              and only the ASSOCIATION is managed. destroy
 *                              releases the box, never the address — DNS keeps
 *                              pointing at an IP the account still owns.
 *   eip_allocation_id null  -> Terraform creates and owns the EIP. destroy
 *                              releases it, and the GoDaddy record must be
 *                              repointed at whatever replaces it.
 *
 * The instance takes a default-subnet auto-assigned public IP at boot (so
 * user-data can reach apt and get.docker.com), which the EIP association then
 * replaces. The demo lives in the DEFAULT VPC on purpose — three subnet tiers
 * and VPC endpoints are the production topology's answer to child data at
 * scale, and building them for one demo box would dress a rehearsal up as the
 * real thing.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
  }

  # Local state, deliberately — see infra/README.md, "envs/demo". No resource
  # here carries a secret, and a hand-run S3 bootstrap for a disposable env
  # would be ceremony without a beneficiary.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "chittu"
      Environment = "demo"
      ManagedBy   = "terraform"
      Repository  = "Tulifo/chittu"
    }
  }
}

# ------------------------------------------------------------------ lookups ---

data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "default_a" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = "${var.region}a"
  default_for_az    = true
}

# Canonical's public SSM alias for the current Ubuntu 24.04 arm64 AMI. The
# instance lifecycle below ignores AMI drift so a new Ubuntu point release
# does not propose replacing a running demo.
data "aws_ssm_parameter" "ubuntu_2404_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# ------------------------------------------------------------------- access ---

resource "aws_key_pair" "demo" {
  key_name_prefix = "chittu-demo-"
  public_key      = var.ssh_public_key
}

resource "aws_security_group" "demo" {
  name_prefix = "chittu-demo-"
  description = "chittu demo - Caddy answers 80/443, SSH from one address"
  vpc_id      = data.aws_vpc.default.id

  tags = { Name = "chittu-demo" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.demo.id
  description       = "SSH, one address only"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
  cidr_ipv4         = var.allowed_ssh_cidr
}

/**
 * 80 and 443 are open to the world and that is REQUIRED, not lazy: Let's
 * Encrypt must reach the box to issue the certificate. Basic auth in the
 * Caddyfile is the gate — the runbook's §10 caveat, not the firewall.
 */
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.demo.id
  description       = "ACME challenges + redirect to HTTPS"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.demo.id
  description       = "the demo, behind Caddy basic auth"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

# Unrestricted egress: apt, get.docker.com, Docker Hub, Let's Encrypt and the
# model provider. This box holds no child data a route table needs to defend —
# that argument belongs to the isolated tier of the real topology.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.demo.id
  description       = "all egress"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ----------------------------------------------------------------- instance ---

resource "aws_instance" "demo" {
  ami                    = data.aws_ssm_parameter.ubuntu_2404_arm64.insecure_value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.default_a.id
  vpc_security_group_ids = [aws_security_group.demo.id]
  key_name               = aws_key_pair.demo.key_name

  # Runbook §3, automated: Docker + Caddy + the two directories.
  user_data = file("${path.module}/user-data.sh")

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true # default aws/ebs key; the demo has no KMS story
    delete_on_termination = true
  }

  tags = { Name = "chittu-demo" }

  lifecycle {
    # The SSM parameter always names the CURRENT AMI. Without this, every new
    # Ubuntu release plans a replacement of a healthy box.
    ignore_changes = [ami]
  }
}

# ---------------------------------------------------------------------- EIP ---

data "aws_eip" "existing" {
  count = var.eip_allocation_id == null ? 0 : 1
  id    = var.eip_allocation_id
}

resource "aws_eip" "created" {
  count  = var.eip_allocation_id == null ? 1 : 0
  domain = "vpc"
  tags   = { Name = "chittu-demo" }
}

locals {
  eip_allocation_id = (
    var.eip_allocation_id != null ? data.aws_eip.existing[0].id : aws_eip.created[0].id
  )
  eip_public_ip = (
    var.eip_allocation_id != null ? data.aws_eip.existing[0].public_ip : aws_eip.created[0].public_ip
  )
}

resource "aws_eip_association" "demo" {
  allocation_id = local.eip_allocation_id
  instance_id   = aws_instance.demo.id
}
