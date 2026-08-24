/**
 * VPC for one Chittu environment.
 *
 * THE SHAPE, AND WHY.
 *
 * Three subnet tiers, not two. Public carries the ALB and nothing else. Private
 * carries the API tasks. Isolated carries the database and has NO route to a
 * NAT gateway at all — not "a security group that denies egress", no route.
 * A subnet with no path out cannot exfiltrate a child's data even if something
 * running in it is fully compromised, and that is a claim the DPIA can make
 * about the route table rather than about our discipline.
 *
 * VPC endpoints rather than NAT for AWS APIs. Two reasons and only one is cost:
 * traffic to S3, ECR, Secrets Manager and CloudWatch never leaves the AWS
 * network, so it is not a cross-border flow that §14's DPIA has to describe.
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
  # Deriving subnet CIDRs rather than taking them as input: three tiers across N
  # AZs is nine hand-written CIDRs in a tfvars file that nobody re-checks, and
  # an overlap shows up as an apply-time error in an environment you were
  # midway through creating.
  az_count = length(var.availability_zones)

  public_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 4, i)]
  private_cidrs  = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 4, i + 4)]
  isolated_cidrs = [for i in range(local.az_count) : cidrsubnet(var.cidr_block, 4, i + 8)]

  tags = merge(var.tags, {
    Environment = var.env
    Module      = "network"
  })
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "chittu-${var.env}" })
}

# ------------------------------------------------------------------ public ---

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "chittu-${var.env}-igw" })
}

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false # the ALB gets its address from the ALB, not from this
  tags = merge(local.tags, {
    Name = "chittu-${var.env}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "chittu-${var.env}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ----------------------------------------------------------------- private ---

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags = merge(local.tags, {
    Name = "chittu-${var.env}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  })
}

/**
 * NAT is OPTIONAL and defaults to off.
 *
 * The API's only outbound need is the model provider, and in dev there is no
 * provider key at all — the stub router serves every turn. A NAT gateway left
 * on in a dev account is both a standing bill and a standing egress path.
 * Production sets nat_gateway = true; dev does not, and finds out immediately
 * rather than discovering the dependency in an incident.
 */
resource "aws_eip" "nat" {
  count  = var.nat_gateway ? local.az_count : 0
  domain = "vpc"
  tags   = merge(local.tags, { Name = "chittu-${var.env}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway ? local.az_count : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "chittu-${var.env}-nat-${count.index}" })
  depends_on    = [aws_internet_gateway.this]
}

# One route table per AZ, so a NAT failure in one AZ cannot black-hole the
# others' egress — which a single shared table would do.
resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id
  tags = merge(local.tags, {
    Name = "chittu-${var.env}-private-${var.availability_zones[count.index]}"
  })
}

resource "aws_route" "private_nat" {
  count                  = var.nat_gateway ? local.az_count : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------- isolated ---

/**
 * The database tier. Its route table gets exactly one entry — the VPC-local
 * route every table has implicitly — and never a 0.0.0.0/0. There is nothing to
 * misconfigure later because there is nothing there.
 */
resource "aws_subnet" "isolated" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.isolated_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags = merge(local.tags, {
    Name = "chittu-${var.env}-isolated-${var.availability_zones[count.index]}"
    Tier = "isolated"
  })
}

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "chittu-${var.env}-isolated" })
}

resource "aws_route_table_association" "isolated" {
  count          = local.az_count
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# --------------------------------------------------------------- endpoints ---

resource "aws_security_group" "endpoints" {
  name_prefix = "chittu-${var.env}-vpce-"
  description = "Interface VPC endpoints — HTTPS from inside the VPC only"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_block]
  }

  tags = merge(local.tags, { Name = "chittu-${var.env}-vpce" })

  lifecycle {
    create_before_destroy = true
  }
}

# Gateway endpoints are free and route-table based, so both private and isolated
# tiers get S3 without any of them gaining a general egress path.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.isolated.id])
  tags              = merge(local.tags, { Name = "chittu-${var.env}-s3" })
}

/**
 * Interface endpoints for what a Fargate task genuinely needs at start:
 * ECR (both, plus S3 above for layer bodies), CloudWatch Logs, Secrets Manager.
 * Deliberately NOT a long list — every endpoint is an hourly charge per AZ, and
 * an endpoint nobody uses is a data flow the DPIA has to describe for nothing.
 */
resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
  ])

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "chittu-${var.env}-${each.value}" })
}

# ----------------------------------------------------------------- flow log ---

/**
 * VPC flow logs. Metadata only by construction — a flow log records five-tuples
 * and byte counts, never payloads — so this is one of the few places we can be
 * generous without touching §2.2's rule about children's words.
 */
resource "aws_flow_log" "this" {
  count                = var.flow_logs ? 1 : 0
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow[0].arn
  iam_role_arn         = aws_iam_role.flow[0].arn
  tags                 = local.tags
}

resource "aws_cloudwatch_log_group" "flow" {
  count             = var.flow_logs ? 1 : 0
  name              = "/chittu/${var.env}/vpc-flow"
  retention_in_days = var.flow_log_retention_days
  tags              = local.tags
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "flow_write" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow[0].arn}:*"]
  }
}

resource "aws_iam_role" "flow" {
  count              = var.flow_logs ? 1 : 0
  name_prefix        = "chittu-${var.env}-flow-"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "flow" {
  count  = var.flow_logs ? 1 : 0
  name   = "write-flow-logs"
  role   = aws_iam_role.flow[0].id
  policy = data.aws_iam_policy_document.flow_write.json
}
