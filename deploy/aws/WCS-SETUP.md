# OpenWA for WCS: setup record and next steps

What was set up to run OpenWA on AWS for the WCS backend, how WCS reaches it, and what is still
left to do. For how the deployment itself works, see [README.md](README.md).

Account `059311035457`, region `ap-south-1`. Written 2026-10-15.

## Summary

- OpenWA runs as one container on one EC2 instance (`OpenwaStack`), with the WhatsApp session on a
  separate, retained, encrypted EBS volume.
- WCS (`WcsBackend` EC2, `i-00558c7cf98586988`) reaches the API privately at
  **`http://openwa.internal:2785`**. The name and port exist only inside the two VPCs; nothing is
  exposed to the internet.
- Deploys run from GitHub Actions through OIDC. No AWS keys are stored in GitHub.
- **The WhatsApp QR scan has not been done yet.** Until it is, the API answers but cannot send
  messages.

## Network path from WCS

```
WcsBackend EC2 (172.31.35.194)            OpenWA EC2
default VPC vpc-079ce24c073ae35a5         OpenwaStack VPC
172.31.0.0/16                             10.42.0.0/16
sg-05b4fea8f7305ea48  ── VPC peering ──►  security group: 2785 from sg-05b4fea8f7305ea48 only
        │                                      │
        └─ openwa.internal ─► A record ─► instance private IP
           (Route 53 private zone, associated with both VPCs)
```

| Piece                    | Value                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| VPC peering              | OpenwaStack VPC ↔ `vpc-079ce24c073ae35a5`                         |
| Route, OpenWA side       | public subnet route table → `172.31.0.0/16` via the peering       |
| Route, WCS side          | `rtb-07025e2a9b5d5fc7f` (default VPC main table) → `10.42.0.0/16` |
| Ingress                  | TCP 2785 from `sg-05b4fea8f7305ea48` only. No CIDR rule, no SSH.  |
| Port binding on the host | `0.0.0.0:2785` because a backend group is configured (see below)  |
| Private DNS              | zone `openwa.internal`, A record → instance private IP, TTL 60    |

All of it is defined in `cdk.json` (`openwa:backendSecurityGroupId`, `openwa:peerVpcId`,
`openwa:peerVpcCidr`, `openwa:peerRouteTableIds`, `openwa:privateDnsName`) and created by
`lib/constructs/openwa-private-access.ts`. If the instance is replaced, the DNS record follows the new
private IP on the same deploy.

**Port binding.** The container publishes 2785 on loopback by default. When
`openwa:backendSecurityGroupId` is set, the runtime config sets `OPENWA_BIND_ADDRESS=0.0.0.0` so the
peered VPC can connect. EC2 public IPs are NAT'd to the private address and never sit on the
instance's interface, so the security group remains the only gate.

**Side effect on the default VPC.** The route was added to the default VPC's _main_ route table, so
everything in that VPC (including WCS's RDS and Redis) has a route to `10.42.0.0/16`. Only OpenWA
listens there, and only WCS's security group is admitted.

## Calling the API from WCS

```bash
curl -fsS -H "X-API-Key: $OPENWA_API_KEY" http://openwa.internal:2785/api/health/ready
curl -fsS -H "X-API-Key: $OPENWA_API_KEY" http://openwa.internal:2785/api/sessions/primary
```

The session id is `primary`. WCS should **not** use the admin key. Once the session is linked,
create a dedicated key for WCS through the tunnel (README §15) and store it in WCS's own secrets:

```bash
curl -fsS -H "X-API-Key: $ADMIN_KEY" -X POST http://localhost:2785/api/keys \
  -H 'Content-Type: application/json' -d '{"name":"wcs-backend","role":"<least role WCS needs>"}'
```

The first-boot admin key is in Secrets Manager at `OpenwaStack/api-master-key` (JSON field
`apiMasterKey`). It is a seed only: changing that secret later rotates nothing (README §15).

## CI/CD and access

| Item                  | Value                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| GitHub environment    | `production` on `opex-labs-ai/OpenWA`                                         |
| Environment variables | `AWS_REGION=ap-south-1`, `AWS_ACCOUNT_ID=059311035457`, `AWS_DEPLOY_ROLE_ARN` |
| Repository secrets    | none                                                                          |
| Deploy role           | `arn:aws:iam::059311035457:role/openwa-github-deploy` (`OpenwaOidcStack`)     |
| Who can assume it     | `repo:opex-labs-ai/OpenWA:environment:production` only                        |
| OIDC provider         | the account's existing `token.actions.githubusercontent.com`, imported        |
| CDK bootstrap         | existing `CDKToolkit` in ap-south-1, qualifier `hnb659fds`                    |

`OpenwaOidcStack` was deployed once by hand with admin credentials. Every later change goes through
the workflows: a push to `main` touching `deploy/aws/**` runs **AWS CDK Deploy**, and on success
**AWS App Deploy** refreshes the runtime bundle on the instance over SSM.

Admin shell and tunnels go through Systems Manager only (stack outputs `SessionManagerCommand` and
`PortForwardCommand`). There is no SSH and no key pair. Anyone with `ssm:StartSession` on the
instance can act as the linked WhatsApp account; treat that permission accordingly.

## Next steps

1. **Confirm the first deploy finished.** Check the AWS CDK Deploy and AWS App Deploy runs on `main`
   and the `OpenwaStack` outputs (`InstanceId`, `PrivateApiUrl`, `PeeringConnectionId`).
2. **Link WhatsApp.** Follow README §8: open the SSM tunnel, read the admin key, create and start
   session `primary`, scan the QR code from the phone that owns the number.
3. **Prove persistence.** Reboot the instance and confirm the session comes back `ready` without a
   new QR code (README §8 step 6). Until this passes, persistence is designed-for but unproven.
4. **Create the WCS API key** (above) and add it to WCS's configuration, with base URL
   `http://openwa.internal:2785`.
5. **Test from WCS.** From the WcsBackend instance:
   `curl -fsS http://openwa.internal:2785/api/health/ready`. If the name does not resolve, check
   the hosted zone's VPC associations; if it times out, check the peering routes and the ingress rule.
6. **Point OpenWA's webhooks at WCS** if WCS needs inbound events. WCS's existing webhook
   (`https://wcs.whatsappify.ai/webhooks/meta`) is for Meta's API; OpenWA events need their own
   endpoint and payload handling.
7. **Set an alarm email** (`openwa:alarmEmail` in `cdk.json`). Without it, the six alarms fire into
   an SNS topic nobody is subscribed to.
8. **Add a required reviewer** to the `production` environment, so a merge to `main` cannot deploy
   without approval.
9. **Refresh the pinned AMI** deliberately from time to time (comment in `cdk.json`), and expect an
   instance replacement when you do. Have the README §14 runbook to hand, because replacement can
   need the manual volume reattach.

## Known limitations

- Single instance, single AZ, no high availability. One replica per session volume, by design.
- WCS's RDS, Redis and EC2 sit in the default VPC. Moving WCS to another VPC means updating the
  peer settings in `cdk.json`.
- OpenWA is unofficial WhatsApp Web automation. Linking a number carries a real risk of restriction
  or ban by WhatsApp.
