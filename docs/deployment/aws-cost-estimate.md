# AWS cost estimate

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | Not used for pricing |
| Model revision | Not used for pricing |
| Environment | `m7i-flex.large` in `ap-southeast-2`, address `3.104.224.113` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft estimate. Not a bill. |

## 1. What was not available

- Cost Explorer, the AWS Price List API, and `describe-instances` were not available. The AWS CLI fails TLS verification while Avast Web/Mail Shield intercepts HTTPS. A signed request on 2026-10-26 returned `AuthFailure`.
- No savings plan, credit balance, tax, or enterprise discount was read.
- The instance was not confirmed to be an Elastic IP. An auto-assigned public address is released when the instance stops. An Elastic IP is billed when allocated.
- The EBS volume type and billed size were not read. `df` showed a 28G root filesystem. The estimate uses 30 GB gp3 as an assumption and shows gp2 as a sensitivity.
- Data transfer volume was not measured and is excluded.
- Snapshots, CloudWatch log ingestion, load balancers, and NAT gateways were not observed. They are excluded, not priced at zero as a finding that they do not exist.

This deployment is not free. Credits were not checked.

## 2. List prices used

| Item | Price | Source | Status |
|---|---|---|---|
| `m7i-flex.large` Linux, shared tenancy, on-demand, `ap-southeast-2` | 0.1197 USD/hour | Daestro and aws-pricing.com regional tables, retrieved 2026-10-27. Not an AWS Price List API response. | Third-party index of the AWS price |
| Public IPv4 in use | 0.005 USD/hour | AWS blog, effective 2024-02-01, all commercial regions | AWS statement. Still the published rate as cited by current pricing explainers. |
| gp3 storage, `ap-southeast-2` | 0.096 USD/GB-month | CloudCostDB and aws-pricing.com, retrieved 2026-10-27 | Assumption that the volume is gp3 |
| gp2 storage, same region | 0.12 USD/GB-month | aws-pricing.com region page | Sensitivity only |
| USD to INR | 95.22 | Interbank reports for 2026-10-27 (about 95.17–95.22). Not a card settlement rate. | Market assumption |

730 hours is the usual full month. 176 hours is 8 hours times 22 weekdays.

## 3. Arithmetic

| Component | Hours or size | USD |
|---|---|---|
| Compute, 176 h | 176 × 0.1197 | 21.07 |
| Compute, 730 h | 730 × 0.1197 | 87.38 |
| Public IPv4, 176 h | 176 × 0.005 | 0.88 |
| Public IPv4, 730 h | 730 × 0.005 | 3.65 |
| Storage, 30 GB gp3, always | 30 × 0.096 | 2.88 |
| Storage, 30 GB gp2, always | 30 × 0.12 | 3.60 |

## 4. Scenarios

All four are calculated estimates. None is an invoice.

### A. POC, instance running 176 hours, address released while stopped

Assumptions: compute and IPv4 only while running; disk remains; gp3 30 GB; no egress.

| | USD | INR at 95.22 |
|---|---|---|
| Compute | 21.07 | 2,006 |
| IPv4 | 0.88 | 84 |
| Disk | 2.88 | 274 |
| Total | 24.83 | 2,364 |

If the address is an Elastic IP left allocated all month, add the idle remainder: (730 − 176) × 0.005 = 2.77 USD. Total 27.60 USD, about 2,628 INR.

### B. Development box running all month

| | USD | INR at 95.22 |
|---|---|---|
| Compute | 87.38 | 8,320 |
| IPv4 | 3.65 | 348 |
| Disk | 2.88 | 274 |
| Total | 93.91 | 8,942 |

gp2 instead of gp3 changes the disk line from 2.88 to 3.60 USD. The total becomes 94.63 USD.

### C. Small production on this same instance

The AWS bill does not increase because the application is called production. Scenario C is scenario B unless a load balancer, a second instance, backups, or a GPU is added. Those were not deployed. Their prices were not pulled and are not invented here.

Operational cost that does not appear on this bill: there is no second instance, no tested restore, and no TLS.

### D. Higher load, two instances of the same type, both all month

| | USD | INR at 95.22 |
|---|---|---|
| Compute | 174.76 | 16,641 |
| IPv4 | 7.30 | 695 |
| Disk, 2 × 30 GB gp3 | 5.76 | 548 |
| Total | 187.82 | 17,884 |

This does not include cross-AZ traffic, a load balancer, or egress. It is an illustration of doubling the known resources, not a sizing recommendation. A GPU price was not retrieved.

## 5. Cost per request

Not calculated. Successful-request volume for a month was not measured. Dividing the monthly estimate by the two observed calls would not be meaningful.

## 6. How to replace this estimate

When an IAM identity can call the account, read-only:

```bash
aws sts get-caller-identity
aws ec2 describe-instances --region ap-southeast-2 --instance-ids i-0f99f1c94ff3ff3e6
aws ec2 describe-volumes --region ap-southeast-2 --filters Name=attachment.instance-id,Values=i-0f99f1c94ff3ff3e6
aws ec2 describe-addresses --region ap-southeast-2
aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-28 --granularity MONTHLY --metrics UnblendedCost
```

Do not run those until certificate verification succeeds without disabling TLS checks. Compare the result with this document and replace the third-party hourly rate with the Price List API value.
