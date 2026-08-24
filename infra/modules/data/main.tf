/**
 * The database, and the keys.
 *
 * TWO CUSTOMER-MANAGED KEYS, NOT ONE. §14 says "KMS CMKs (child-data, training
 * — separate)" and the separation is the entire point: the training pipeline
 * must be unable to decrypt a child's conversation even by mistake. One key
 * with two grants is one IAM error away from a corpus of real children's turns.
 * Two keys, and the training role is not a principal on the child-data key at
 * all, so the failure mode is AccessDenied rather than a dataset.
 *
 * Law 06 and the training-data doctrine (architecture §11) say real children's
 * conversations never become training data. That is a promise; this is the part
 * of it a key policy can enforce.
 *
 * THE DATABASE IS NOT PUBLIC AND CANNOT BE MADE PUBLIC by flipping one boolean:
 * it lives in the isolated subnet tier, which has no route to a NAT gateway.
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
}

locals {
  tags = merge(var.tags, {
    Environment = var.env
    Module      = "data"
  })
}

data "aws_caller_identity" "current" {}

# --------------------------------------------------------------------- KMS ---

data "aws_iam_policy_document" "child_data_key" {
  # The account root retains administrative control; without this statement the
  # key becomes unmanageable the moment the creating principal goes away.
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "RuntimeUse"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = var.runtime_role_arns
    }
  }

  # Named explicitly so the absence is legible in a review: the training roles
  # appear nowhere in this document, and that is the enforcement.
  statement {
    sid       = "TrainingIsNotAPrincipalOnThisKey"
    effect    = "Deny"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = length(var.training_role_arns) > 0 ? var.training_role_arns : ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "child_data" {
  description             = "chittu ${var.env} — child data at rest. Training roles are denied."
  deletion_window_in_days = var.env == "prod" ? 30 : 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.child_data_key.json
  tags                    = merge(local.tags, { DataClass = "child" })
}

resource "aws_kms_alias" "child_data" {
  name          = "alias/chittu-${var.env}-child-data"
  target_key_id = aws_kms_key.child_data.key_id
}

resource "aws_kms_key" "training" {
  description             = "chittu ${var.env} — synthetic training corpora only. Never child data."
  deletion_window_in_days = var.env == "prod" ? 30 : 7
  enable_key_rotation     = true
  tags                    = merge(local.tags, { DataClass = "synthetic" })
}

resource "aws_kms_alias" "training" {
  name          = "alias/chittu-${var.env}-training"
  target_key_id = aws_kms_key.training.key_id
}

# ---------------------------------------------------------------- password ---

/**
 * Generated here and never printed. It goes straight into Secrets Manager, the
 * task definition references the secret ARN, and the plaintext exists only in
 * state — which is why the backend is S3 with encryption and restricted access
 * (see each env's backend.tf) and why no output in this module exposes it.
 */
resource "random_password" "db" {
  length  = 40
  special = false # RDS rejects several punctuation classes in master passwords
}

resource "aws_secretsmanager_secret" "db" {
  name_prefix = "chittu/${var.env}/db-"
  description = "chittu ${var.env} Postgres master credentials"
  kms_key_id  = aws_kms_key.child_data.arn
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.master_username
    password = random_password.db.result
    dbname   = var.database_name
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    url      = "postgres://${var.master_username}:${random_password.db.result}@${aws_db_instance.this.endpoint}/${var.database_name}"
  })
}

# --------------------------------------------------------------------- RDS ---

resource "aws_db_subnet_group" "this" {
  name_prefix = "chittu-${var.env}-"
  subnet_ids  = var.isolated_subnet_ids
  tags        = local.tags
}

resource "aws_security_group" "db" {
  name_prefix = "chittu-${var.env}-db-"
  description = "Postgres — from the API tasks only"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "chittu-${var.env}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

/**
 * THE INGRESS RULE IS NOT HERE. It lives in the environment root, and that is
 * a structural necessity rather than a style choice: this module needs the API
 * task security group, and the api module needs this module's secret ARN. As
 * modules that is a cycle, which Terraform rejects. The root knows both, so the
 * one rule that crosses the boundary is declared there — see envs/dev/main.tf.
 *
 * It references a security GROUP, not a CIDR: the set of task IPs changes on
 * every deploy, the group does not.
 */

# No egress rule at all. Postgres answers connections; it does not open them,
# and the isolated tier has nowhere to open them to.

resource "aws_db_parameter_group" "this" {
  name_prefix = "chittu-${var.env}-pg16-"
  family      = "postgres16"
  description = "chittu ${var.env}"

  # pgvector, per architecture §2.2. Shared_preload is not required for vector,
  # but pg_stat_statements is how a slow query gets found without logging one.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  /**
   * log_statement = none, deliberately and not by default.
   *
   * `all` or `mod` writes SQL text into the Postgres log, and this schema's
   * INSERTs carry a child's turn as a bind parameter. §2.2's rule — message
   * bodies never enter a log line — has to hold at the database too, not only
   * in the application logger.
   */
  parameter {
    name  = "log_statement"
    value = "none"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1" # never log a statement for being slow; use pg_stat_statements
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier_prefix = "chittu-${var.env}-"
  engine            = "postgres"
  engine_version    = var.engine_version
  instance_class    = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.child_data.arn

  db_name  = var.database_name
  username = var.master_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  parameter_group_name = aws_db_parameter_group.this.name

  backup_retention_period = var.backup_retention_days
  backup_window           = "18:00-19:00" # ~23:30 IST, off-peak for the launch market
  maintenance_window      = "sun:19:30-sun:20:30"
  copy_tags_to_snapshot   = true

  # Snapshots inherit the child-data key. A snapshot is a copy of every
  # conversation in the database and must not be readable with anything less.
  deletion_protection = var.env == "prod"
  skip_final_snapshot = var.env != "prod"
  final_snapshot_identifier = (
    var.env == "prod" ? "chittu-${var.env}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}" : null
  )

  performance_insights_enabled    = var.env == "prod"
  performance_insights_kms_key_id = var.env == "prod" ? aws_kms_key.child_data.arn : null

  # postgresql only. `upgrade` is fine too, but NOT anything that could carry
  # statement text — see log_statement above.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  auto_minor_version_upgrade = true
  apply_immediately          = var.env != "prod"

  tags = merge(local.tags, { DataClass = "child" })

  lifecycle {
    # The timestamp() in final_snapshot_identifier would otherwise propose a
    # replacement on every single plan.
    ignore_changes = [final_snapshot_identifier]
  }
}
