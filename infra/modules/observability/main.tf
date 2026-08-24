/**
 * Log groups, and the rule that a child's words never reach one.
 *
 * §2.2: "Message bodies never enter a trace, span or log line. Enforced by a
 * redacting processor." That processor exists in the application
 * (apps/api/src/logging.ts, a pino path deny-list). THIS module is the second
 * wall, on the assumption the first one is edited by someone who does not know
 * why it is there.
 *
 * The primitive is a CloudWatch Logs DATA PROTECTION POLICY, which masks at
 * ingest: matched values are replaced before they are stored, so the unmasked
 * text never lands in the log at all. That distinction matters — a metric
 * filter or a subscription that "alerts on" a leak still means the leak is
 * sitting in the log group.
 *
 * WHAT IT CAN AND CANNOT DO, honestly.
 *
 * Managed identifiers (email, phone, credit card…) are AWS's and are good. The
 * custom identifiers below catch the JSON shape our own logger would produce if
 * its deny-list were bypassed — `"text":"…"`, `"reply":"…"` and so on. What
 * NOTHING here can do is recognise a child's sentence appearing as free prose
 * inside an unexpected field, because "i want to die" is not distinguishable by
 * pattern from ordinary text. That is exactly why the application-side deny
 * list is the primary control and this is the backstop, not the reverse.
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
    Module      = "observability"
  })

  # The field names apps/api/src/logging.ts redacts. Kept in step with
  # SENSITIVE_PATHS there — if you add one, add it in both places; a field
  # redacted in the app and unknown here is fine, the reverse is the gap.
  body_fields = [
    "text", "body", "message", "content", "transcript", "reply", "prompt",
    "fact", "memory", "memories",
  ]
  credential_fields = [
    "pin", "apiKey", "api_key", "token", "password", "secret",
  ]
}

resource "aws_cloudwatch_log_group" "app" {
  for_each = toset(var.log_groups)

  name              = "/chittu/${var.env}/${each.value}"
  retention_in_days = var.retention_in_days
  kms_key_id        = var.kms_key_arn
  tags              = merge(local.tags, { Service = each.value })
}

/**
 * One policy per group. `Audit` writes a *finding* — which fields matched, not
 * the values — to a separate group, so a leak is visible without being
 * re-published in the process of reporting it.
 */
resource "aws_cloudwatch_log_data_protection_policy" "app" {
  for_each = aws_cloudwatch_log_group.app

  log_group_name = each.value.name

  policy_document = jsonencode({
    Name    = "chittu-${var.env}-no-child-words"
    Version = "2021-06-01"

    Configuration = {
      CustomDataIdentifier = [
        {
          Name = "ChittuMessageBody"
          # A JSON field we redact in the app, carrying a non-empty value.
          Regex = "\"(${join("|", local.body_fields)})\"\\s*:\\s*\"[^\"]+\""
        },
        {
          Name  = "ChittuCredential"
          Regex = "\"(${join("|", local.credential_fields)})\"\\s*:\\s*\"[^\"]+\""
        },
        {
          Name = "ChittuEscalationToken"
          # The sandbox's control tokens. These are not secrets, but seeing one
          # in a log means a raw model output reached a sink unfiltered, which
          # is worth catching at the same place.
          Regex = "\\b(CRISIS|UNSAFE|SPINE|PII)\\b"
        },
      ]

      DataIdentifier = [
        "arn:aws:dataprotection::aws:data-identifier/EmailAddress",
        "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-IN",
        "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-GB",
        "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-US",
      ]
    }

    Statement = [
      {
        Sid = "AuditWhatMatched"
        DataIdentifier = concat(
          ["arn:aws:dataprotection::aws:data-identifier/EmailAddress",
            "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-IN",
            "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-GB",
          "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-US"],
          ["ChittuMessageBody", "ChittuCredential", "ChittuEscalationToken"],
        )
        Operation = {
          Audit = {
            FindingsDestination = {
              CloudWatchLogs = {
                LogGroup = aws_cloudwatch_log_group.findings.name
              }
            }
          }
        }
      },
      {
        Sid = "MaskBeforeItIsStored"
        DataIdentifier = concat(
          ["arn:aws:dataprotection::aws:data-identifier/EmailAddress",
            "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-IN",
            "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-GB",
          "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-US"],
          ["ChittuMessageBody", "ChittuCredential", "ChittuEscalationToken"],
        )
        Operation = {
          Deidentify = {
            MaskConfig = {}
          }
        }
      },
    ]
  })
}

/**
 * Findings go to their own group with SHORT retention. A finding names the
 * identifier and the position — not the value — but it is still a record that
 * something matched, and it has no long-term use.
 */
resource "aws_cloudwatch_log_group" "findings" {
  name              = "/chittu/${var.env}/data-protection-findings"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
  tags              = merge(local.tags, { Service = "data-protection-findings" })
}

/**
 * An alarm on the findings group. A match is not "informational": it means the
 * application-side redaction did not hold, and the second wall did the work.
 * Nobody reads a log group on a schedule, so this pages instead.
 */
resource "aws_cloudwatch_log_metric_filter" "findings" {
  name           = "chittu-${var.env}-redaction-findings"
  log_group_name = aws_cloudwatch_log_group.findings.name
  pattern        = "" # every event in this group is a finding

  metric_transformation {
    name      = "RedactionFindings"
    namespace = "Chittu/${var.env}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "findings" {
  count = var.alarm_topic_arn == null ? 0 : 1

  alarm_name        = "chittu-${var.env}-redaction-finding"
  alarm_description = "A child's words, a credential or an escalation token reached a log group and were masked at ingest. The application-side deny-list in apps/api/src/logging.ts did not hold. Treat as a privacy incident, not a warning."

  namespace           = "Chittu/${var.env}"
  metric_name         = "RedactionFindings"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
  tags          = local.tags
}
