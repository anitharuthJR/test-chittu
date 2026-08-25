/**
 * The dev environment.
 *
 * Same modules as staging and prod, different tfvars — that is the whole point
 * of §14's layout, and the reason Phase 2's per-market residency is "instantiate
 * these again in another region" rather than a project.
 *
 * NOTHING IN THIS DIRECTORY HAS EVER BEEN APPLIED. See infra/README.md.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }

  # Backend is deliberately in its own file so that `terraform init
  # -backend=false` can validate this configuration with no AWS account at all,
  # which is exactly how it has been checked so far.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project    = "chittu"
      ManagedBy  = "terraform"
      Repository = "Tulifo/chittu"
    }
  }
}

locals {
  env = "dev"
  tags = {
    Owner = "platform"
  }
}

module "network" {
  source = "../../modules/network"

  env                = local.env
  region             = var.region
  cidr_block         = var.cidr_block
  availability_zones = var.availability_zones

  # Dev has no provider key, so the stub router serves every turn and there is
  # nothing outbound to reach. A NAT gateway here would be a standing bill and a
  # standing egress path for no benefit.
  nat_gateway = false

  tags = local.tags
}

module "observability" {
  source = "../../modules/observability"

  env               = local.env
  retention_in_days = 14

  # No SNS topic in dev, so no alarm. Prod must set one — a redaction finding
  # nobody is paged for is a privacy incident nobody knows about.
  alarm_topic_arn = null

  tags = local.tags
}

module "data" {
  source = "../../modules/data"

  env                 = local.env
  vpc_id              = module.network.vpc_id
  isolated_subnet_ids = module.network.isolated_subnet_ids

  runtime_role_arns  = [module.api.task_role_arn, module.api.execution_role_arn]
  training_role_arns = [] # no training infrastructure in dev

  instance_class        = "db.t4g.micro"
  multi_az              = false
  backup_retention_days = 1

  tags = local.tags
}

module "api" {
  source = "../../modules/api"

  env                = local.env
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image           = var.image
  certificate_arn = var.certificate_arn

  db_secret_arn        = module.data.db_secret_arn
  child_data_key_arn   = module.data.child_data_key_arn
  db_security_group_id = module.data.db_security_group_id

  # Null in dev. main.ts refuses to start in production without one — the stub
  # router classifies every turn SAFE — but NODE_ENV is production in the image,
  # so dev must either supply a key or accept that the service will refuse.
  # It refuses. That is the honest default and it is documented in the README.
  provider_key_secret_arn = var.provider_key_secret_arn

  # No null here, unlike the provider key. A deployment without a stable
  # blind-index key does not degrade — it silently loses the ability to find a
  # parent by email from any task but the one that wrote the row.
  index_key_secret_arn = var.index_key_secret_arn

  log_group_name         = module.observability.log_group_names["api"]
  log_group_arn          = module.observability.log_group_arns["api"]
  migrate_log_group_name = module.observability.log_group_names["migrate"]

  desired_count = 1
  cpu           = 512
  memory        = 1024

  tags = local.tags
}

/**
 * The one rule that crosses a module boundary in both directions.
 *
 * `data` would need the API's security group and `api` needs `data`'s secret
 * ARN; as module-to-module edges that is a cycle Terraform rejects. The root
 * knows both, so the rule is declared here. It is not a leftover — moving it
 * back into either module reintroduces the cycle.
 */
resource "aws_vpc_security_group_ingress_rule" "db_from_api" {
  security_group_id            = module.data.db_security_group_id
  description                  = "Postgres from the API tasks, and nothing else"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = module.api.task_security_group_id
}
