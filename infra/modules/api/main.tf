/**
 * The API service: ECS Fargate behind an ALB, with a WAF in front.
 *
 * THE MIGRATION IS A SEPARATE TASK DEFINITION, NOT A CONTAINER IN THIS ONE.
 * bootstrapDb() deliberately does not migrate the Postgres path, because a
 * service that migrates on boot runs N times concurrently the first moment it
 * scales past one task. The deployment shape is: run the migrate task to
 * completion, then update the service. That is what compose.yaml rehearses
 * locally and what docs/runbooks describes; this module provides the task
 * definition and deliberately does NOT wire it into an automatic trigger,
 * because "migrate, then deploy" is an ordering a human or a pipeline owns.
 *
 * SECRETS ARE REFERENCED, NEVER PASSED. `secrets` in a container definition
 * takes an ARN and ECS resolves it at task start. Putting the value in
 * `environment` would place it in the task definition, which is readable by
 * anyone with ecs:DescribeTaskDefinition and is printed by `terraform plan`.
 */

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
  }
}

locals {
  tags = merge(var.tags, {
    Environment = var.env
    Module      = "api"
  })
  name = "chittu-${var.env}-api"
}

data "aws_region" "current" {}

# ------------------------------------------------------------ security groups ---

resource "aws_security_group" "alb" {
  name_prefix = "chittu-${var.env}-alb-"
  description = "ALB — HTTPS from the internet"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "chittu-${var.env}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

/**
 * Port 80 exists only to redirect. No child's request is served over it, and
 * the redirect is issued by the ALB before anything reaches a task.
 */
resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS at the listener"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "to the API tasks"
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_security_group" "tasks" {
  name_prefix = "chittu-${var.env}-tasks-"
  description = "API tasks"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "chittu-${var.env}-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "from the ALB only"
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

/**
 * Egress is HTTPS-only and unrestricted by destination, which is the honest
 * shape: the task must reach the model provider, and pinning that to an IP
 * range would break the first time the provider changed one. What bounds the
 * blast radius is that the DATABASE tier cannot be reached this way and the
 * database subnets have no egress of their own.
 */
resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS out — model provider, VPC endpoints"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "tasks_postgres" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Postgres"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = var.db_security_group_id
}

# ----------------------------------------------------------------------- ALB ---

resource "aws_lb" "this" {
  name_prefix        = "chittu"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = var.env == "prod"

  # Longer than the longest turn: a model call plus the pipeline. A 60s default
  # would cut off a slow sandbox response and show a child an error.
  idle_timeout = 120

  tags = local.tags
}

resource "aws_lb_target_group" "this" {
  name_prefix = "chittu"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # 30s is long enough for a task to drain an in-flight turn and short enough
  # that a deploy is not visibly slow.
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  tags = local.tags
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.tags
}

# ----------------------------------------------------------------------- WAF ---

/**
 * Rate limiting is the rule that matters here, and it is deliberately per-IP
 * and generous. This is a service for children: an aggressive limit turns a
 * shared school or household NAT into "Chittu is broken", and there is no
 * support path for a nine-year-old.
 */
resource "aws_wafv2_web_acl" "this" {
  name  = "chittu-${var.env}"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "chittu-${var.env}-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-common"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # SizeRestrictions_BODY caps a request body at 8KB. A child pasting a
        # long homework question is a legitimate request, and this rule would
        # reject it as an attack.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "chittu-${var.env}-common"
      sampled_requests_enabled   = false
    }
  }

  /**
   * sampled_requests_enabled = false EVERYWHERE, and this is not a cost choice.
   * WAF request sampling stores the request — including its body — where it can
   * be read from the console. A sampled POST /v1/session/:id/turn is a child's
   * sentence sitting in a second system that §2.2's redaction never touches.
   */
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "chittu-${var.env}"
    sampled_requests_enabled   = false
  }

  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# ---------------------------------------------------------------------- IAM ---

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The EXECUTION role is used by the ECS agent to pull the image and fetch
# secrets. The TASK role is what the application itself gets. Keeping them
# separate means application code never inherits "can read every secret".
resource "aws_iam_role" "execution" {
  name_prefix        = "chittu-${var.env}-exec-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = compact([
      var.db_secret_arn, var.provider_key_secret_arn, var.index_key_secret_arn,
    ])
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.child_data_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-task-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name_prefix        = "chittu-${var.env}-task-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

/**
 * The task role is nearly empty on purpose. The application talks to Postgres
 * with a password and to the provider over HTTPS; it has no reason to call an
 * AWS API at all. Anything added here should have to justify itself.
 */
data "aws_iam_policy_document" "task" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.log_group_arn}:*"]
  }

  /**
   * Envelope encryption, and the two operations it needs — no more.
   *
   * GenerateDataKey mints a per-child DEK; Decrypt unwraps it to read that
   * child's rows. `kms:Encrypt` is NOT here: GenerateDataKey already returns
   * both halves, so nothing in the application ever encrypts under the CMK
   * directly. Scoped to the child-data CMK alone — the training key is a
   * different key precisely so this role cannot reach it (Law 06).
   *
   * This is the exception the comment above anticipates. It justifies itself:
   * without it the service falls back to a process-local master key, which is
   * a DIFFERENT key in every task and is discarded on restart.
   */
  statement {
    sid       = "EnvelopeEncryptChildData"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.child_data_key_arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# --------------------------------------------------------------------- ECS ---

resource "aws_ecs_cluster" "this" {
  name = "chittu-${var.env}"

  setting {
    name  = "containerInsights"
    value = var.env == "prod" ? "enabled" : "disabled"
  }

  tags = local.tags
}

locals {
  # Shared by both task definitions, so the migration runs against exactly the
  # database the service will use, with the same secret and the same log policy.
  base_environment = [
    { name = "NODE_ENV", value = "production" },
    # Empty means "stdout only" (apps/api/src/logging.ts). A file on a task that
    # can be replaced at any moment is not a record anyone can rely on.
    { name = "LOG_DIR", value = "" },
    { name = "AWS_REGION", value = data.aws_region.current.region },
    # Presence of this is what selects the KMS key provider. Absent, the service
    # refuses to start rather than falling back to a process-local master key.
    { name = "CHITTU_KMS_KEY_ARN", value = var.child_data_key_arn },
  ]

  base_secrets = concat(
    [
      { name = "DATABASE_URL", valueFrom = "${var.db_secret_arn}:url::" },
      # The blind-index key. A SECRET, not an environment entry: `environment`
      # is readable from the task definition by anyone who can DescribeTaskDefinition,
      # and this value reverses `parent.email_hash` for every family.
      { name = "CHITTU_INDEX_KEY", valueFrom = var.index_key_secret_arn },
    ],
    var.provider_key_secret_arn == null ? [] : [
      { name = "ANTHROPIC_API_KEY", valueFrom = var.provider_key_secret_arn }
    ],
  )
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.image
    essential = true

    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]

    environment = concat(local.base_environment, [
      { name = "PORT", value = tostring(var.container_port) },
      # 0.0.0.0 is set here and nowhere else — main.ts defaults to loopback so a
      # laptop never publishes its API to the local network by accident.
      { name = "HOST", value = "0.0.0.0" },
    ])
    secrets = local.base_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.log_group_name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = "api"
      }
    }

    healthCheck = {
      command  = ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:${var.container_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval = 30
      timeout  = 5
      retries  = 3
      # The image is distroless: node is the only executable, hence the absolute
      # path and the absence of a shell form.
      startPeriod = 40
    }

    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = false # node is PID 1 and handles SIGTERM itself
    }
  }])

  tags = local.tags
}

/**
 * The migration task. Same image, different command, and it runs to completion.
 * Not part of the service and not an ECS "task set" — this is invoked by a
 * deployment step before the service is updated.
 */
resource "aws_ecs_task_definition" "migrate" {
  family                   = "chittu-${var.env}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = var.image
    essential   = true
    command     = ["dist/migrate.js"]
    environment = local.base_environment
    secrets     = local.base_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.migrate_log_group_name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = "migrate"
      }
    }

    readonlyRootFilesystem = true
  }])

  tags = local.tags
}

resource "aws_ecs_service" "this" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  # Give a new task time to pass /health before the ALB judges it.
  health_check_grace_period_seconds = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200 so a deploy adds capacity before removing any: at desired_count 1,
  # 50% minimum would mean zero healthy tasks mid-deploy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  propagate_tags = "SERVICE"
  tags           = local.tags

  depends_on = [aws_lb_listener.https]

  lifecycle {
    # The image tag is moved by a deployment, not by Terraform. Without this,
    # every plan after a deploy proposes reverting to the tag in tfvars.
    ignore_changes = [task_definition]
  }
}
