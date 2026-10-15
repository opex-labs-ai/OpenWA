# OpenWA on AWS

A production-oriented deployment of a **single** OpenWA WhatsApp session on the smallest practical
AWS footprint: one EC2 instance running the published Docker image, with the WhatsApp session on a
separate encrypted EBS volume that survives instance replacement and stack destruction.

> **Status: not yet deployed.** Everything here compiles, synthesises, passes its unit tests and
> passes shell, compose and workflow linting — see [Validation status](#validation-status) for
> exactly what has and has not been exercised. No claim is made that this has run on AWS, or that
> WhatsApp authentication has been performed, because neither has happened yet.

---

## Contents

1. [Architecture](#1-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Repository structure](#3-repository-structure)
4. [AWS bootstrap](#4-aws-bootstrap)
5. [GitHub OIDC configuration](#5-github-oidc-configuration)
6. [GitHub variables and secrets](#6-github-variables-and-secrets)
7. [Initial CDK deployment](#7-initial-cdk-deployment)
8. [First-time OpenWA authentication](#8-first-time-openwa-authentication)
9. [Persistent session storage](#9-persistent-session-storage)
10. [Automatic deployments](#10-automatic-deployments)
11. [Health checks](#11-health-checks)
12. [Logs](#12-logs)
13. [Backups](#13-backups)
14. [Recovery](#14-recovery)
15. [Secret rotation](#15-secret-rotation)
16. [Image upgrades](#16-image-upgrades)
17. [Rollback](#17-rollback)
18. [Cost](#18-cost)
19. [Security controls](#19-security-controls)
20. [Troubleshooting](#20-troubleshooting)
21. [Destroying the stack without losing the session](#21-destroying-the-stack-without-losing-the-session)

Also: [Configuration reference](#configuration-reference) · [Validation status](#validation-status) ·
[Limitations](#limitations) · [WhatsApp terms](#whatsapp-terms-and-risk)

---

## 1. Architecture

```
┌─ VPC, one AZ, one public subnet, internet gateway, NO NAT gateway ────────────┐
│                                                                                │
│  Security group:  ingress = NOTHING        egress = 443, 80, DNS, NTP          │
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────┐              │
│  │ EC2 t3.small · Amazon Linux 2023 · IMDSv2 required           │              │
│  │ Public IPv4 for egress only — unreachable, no ingress rule   │              │
│  │                                                               │              │
│  │  /                    20 GiB gp3, encrypted, ephemeral        │              │
│  │  /opt/openwa/app      compose file + deploy scripts           │              │
│  │  /opt/openwa/data  ◄── SEPARATE gp3, encrypted, RETAINED      │              │
│  │                        baileys/  sessions/  main.sqlite       │              │
│  │                        openwa.sqlite  media/  plugins/        │              │
│  │                        .api-key  .env.generated               │              │
│  │                                                               │              │
│  │  docker compose → one container, image pinned by digest       │              │
│  │    bound to 127.0.0.1:2785 only · ENGINE_TYPE=baileys         │              │
│  └──────────────────────────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────────────────────────┘
        │ egress
        ├──► GHCR (image pull)          ├──► Secrets Manager (API key seed)
        ├──► WhatsApp servers            ├──► CloudWatch Logs + Metrics
        └──► Systems Manager (Session Manager, Run Command)

Administration:  aws ssm start-session        (no SSH, no open port 22)
Deployment:      GitHub Actions ──OIDC──► deploy role ──► CloudFormation / SSM
Backups:         Data Lifecycle Manager, daily encrypted EBS snapshot
```

### The two decisions worth understanding

**Why a public IPv4 address with no ingress rule.** A security group with no ingress rules denies
all inbound traffic — there is nothing to reach, on any port. The public address exists only so the
internet gateway can route return traffic for connections the instance opens. Avoiding a public
address altogether would require either a NAT gateway or a set of VPC interface endpoints, and in
the endpoint case also moving off GHCR to ECR, because GHCR would become unreachable. Both cost
roughly ten times what the address does. The trade-off is deliberate, and it is the one place this
deployment departs from "no public IP".

**Why the session volume is a separate resource.** If the data volume were a block device on the
instance, it would share the instance's lifecycle and be destroyed with it. It is instead a
stand-alone `AWS::EC2::Volume` with `DeletionPolicy: Retain` **and** `UpdateReplacePolicy: Retain`,
attached separately. WhatsApp authentication state cannot be recovered without scanning a new QR
code, so every design choice here favours the volume surviving over operational convenience.

### What is deliberately not used

No ECS, EKS or Fargate. No EFS, RDS, ElastiCache or Redis. No NAT gateway. No load balancer. No
public API endpoint. There is one asterisk: CDK's `restrictDefaultSecurityGroup` creates a one-shot
Lambda-backed custom resource to close the VPC's default security group, which nothing in this
deployment uses. It runs at deploy time only and has no recurring cost. The assertion suite enforces
the absence of all of the above.

---

## 2. Prerequisites

| Requirement            | Notes                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                | The version in `.nvmrc` at the repository root (currently 22). `package.json` requires `>=22.19`.                                                                         |
| An AWS account         | With permission to run `cdk bootstrap` once.                                                                                                                              |
| AWS CLI v2             | For the bootstrap, and for every runbook in this document.                                                                                                                |
| Session Manager plugin | Needed for `aws ssm start-session`. [Install instructions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) |
| A GitHub repository    | With permission to create a `production` environment and repository variables.                                                                                            |
| Docker                 | Optional locally. `scripts/validate-config.sh` uses it to validate the compose file and skips that check when it is absent.                                               |

The CDK CLI is a dev dependency of this project, so there is nothing to install globally — every
command below uses `npx cdk`.

```bash
cd deploy/aws
npm ci
```

---

## 3. Repository structure

```
deploy/aws/
├── bin/openwa.ts                     CDK app entry; declares both stacks
├── lib/
│   ├── openwa-stack.ts               the application stack
│   ├── openwa-oidc-stack.ts          bootstrap stack: OIDC provider + deploy role
│   ├── constructs/
│   │   ├── openwa-ec2.ts             VPC, security group, instance, volume, role, secret
│   │   ├── openwa-observability.ts   SNS topic and the six alarms
│   │   ├── openwa-backup.ts          DLM snapshot policy and its service role
│   │   └── github-oidc.ts            provider (create or import) + the restricted role
│   └── config/environment.ts         typed configuration; throws on anything invalid
├── userdata/bootstrap.sh             EC2 user data. Changing it REPLACES the instance.
├── runtime/                          shipped to the instance as an S3 asset
│   ├── compose.yaml                  the container definition
│   ├── install.sh                    applies a bundle: agent config, systemd units
│   ├── deploy.sh                     the deployment, and every session-safety guard
│   ├── healthcheck.sh                publishes the four health states to CloudWatch
│   ├── backup.sh                     wrapper over the repository's own scripts/backup.sh
│   ├── openwa.service                starts the container, ordered after the EBS mount
│   ├── openwa-health.service|.timer  runs the health probe every five minutes
│   └── cloudwatch-agent.json         memory, disk and log collection
├── scripts/
│   ├── bootstrap-github-oidc.sh      idempotent OIDC provider bootstrap
│   ├── validate-config.sh            every local check, no AWS credentials needed
│   └── verify-deployment.sh          read-only post-deployment verification
├── test/openwa-stack.test.ts         56 assertions over the templates and the runtime bundle
└── cdk.json                          all configuration lives here
```

The split between `userdata/` and `runtime/` is load-bearing. User data is inlined into the launch
configuration, so **any change to `userdata/bootstrap.sh` replaces the instance**. `runtime/` travels
as an S3 asset whose location the instance reads from an SSM parameter, so changing a script there
does not. The pinned image digest lives in the runtime config parameter for the same reason: a new
image must not rebuild the machine holding the session.

---

## 4. AWS bootstrap

One-time, with administrative credentials.

```bash
cd deploy/aws
export AWS_REGION=ap-south-1          # or your region
npx cdk bootstrap aws://<account-id>/$AWS_REGION
```

> **Be aware what `cdk bootstrap` grants.** By default it creates a CloudFormation execution role
> with `AdministratorAccess`. The GitHub Actions role created in the next step has nothing of the
> sort — it can only assume the bootstrap roles — but the chain as a whole is only as narrow as that
> execution role. To tighten it, bootstrap with explicit policies instead:
>
> ```bash
> npx cdk bootstrap aws://<account-id>/$AWS_REGION \
>   --cloudformation-execution-policies \
>   'arn:aws:iam::aws:policy/AmazonEC2FullAccess,arn:aws:iam::aws:policy/CloudWatchFullAccess,arn:aws:iam::aws:policy/SecretsManagerReadWrite,arn:aws:iam::aws:policy/AmazonSSMFullAccess,arn:aws:iam::aws:policy/IAMFullAccess'
> ```
>
> `IAMFullAccess` is still needed, because the stack creates the instance role. This is narrower than
> the default, not least-privilege. Stated plainly rather than implied away.

---

## 5. GitHub OIDC configuration

The deployment role cannot be created by the workflow that needs it, so it lives in a separate stack
deployed once by a human.

```bash
cd deploy/aws
npx cdk deploy OpenwaOidcStack
```

Note the `DeployRoleArn` output.

**If the account already has a GitHub OIDC provider** — AWS permits exactly one per URL per account,
so the above will fail. Import the existing one instead:

```bash
bash scripts/bootstrap-github-oidc.sh     # idempotent; prints the provider ARN
```

Put the printed ARN into `cdk.json` as `openwa:githubOidcProviderArn`, then run the `cdk deploy`
above again. CDK will import the provider rather than create a second.

### What the role can and cannot do

The trust policy accepts only the subject in `openwa:githubDeployRefs`, which defaults to
`repo:opex-labs-ai/OpenWA:environment:production`, with the audience pinned to `sts.amazonaws.com`.

The environment form matters: when a workflow job declares `environment:`, GitHub's `sub` claim
becomes `repo:<owner>/<repo>:environment:<name>` and **does not carry the branch ref**. A ref-only
condition such as `ref:refs/heads/main` would reject the workflows in this repository. If you remove
`environment: production` from the workflows, change this to the ref form.

The role holds no permission to create any resource. It can assume the CDK bootstrap roles, read the
bootstrap version parameter, run `AWS-RunShellScript` on instances tagged `openwa-managed=true`, and
make a handful of read-only describe calls. No `AdministratorAccess`, no `PowerUserAccess`.

---

## 6. GitHub variables and secrets

Set these as repository **variables** (Settings → Secrets and variables → Actions → Variables), or
on the `production` environment. None is sensitive.

| Name                  | Kind     | Example                                               | Purpose                                |
| --------------------- | -------- | ----------------------------------------------------- | -------------------------------------- |
| `AWS_REGION`          | Variable | `ap-south-1`                                          | Target region                          |
| `AWS_ACCOUNT_ID`      | Variable | `123456789012`                                        | `CDK_DEFAULT_ACCOUNT` for synthesis    |
| `AWS_DEPLOY_ROLE_ARN` | Variable | `arn:aws:iam::123456789012:role/openwa-github-deploy` | The `DeployRoleArn` output from step 5 |

**Secrets: none.** That is the point of OIDC — there is nothing to store and nothing to rotate. Do
not create an AWS access key for this.

You must also create the **`production` environment** (Settings → Environments → New environment →
`production`). All three workflows reference it, and it is what produces the `environment:production`
OIDC subject. Add required reviewers there if you want deployments and destroys to need approval.

---

## 7. Initial CDK deployment

Either push to `main` with a change under `deploy/aws/`, or run the **AWS CDK Deploy** workflow
manually, or deploy locally:

```bash
cd deploy/aws
export AWS_REGION=ap-south-1
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=$AWS_REGION

npx cdk diff OpenwaStack      # read this before the first deploy
npx cdk deploy OpenwaStack
bash scripts/verify-deployment.sh
```

`verify-deployment.sh` is read-only. It checks the stack reached a completed state, the instance is
registered with Systems Manager, the persistent volume is mounted, the container is running and the
API answers — and reports, without failing, that WhatsApp is not yet authenticated. That is expected
until step 8.

### The AMI is pinned, and why that matters

`openwa:amiId` in `cdk.json` is pinned to a specific Amazon Linux 2023 image
(`ami-0d5beb611c244cba5`, `al2023-ami-2023.12.20261013.0-kernel-6.1-x86_64`, ap-south-1).

This is not tidiness. Left unpinned, every deploy resolves "latest", so any upstream AL2023 release
changes the `ImageId` and **replaces the instance during an unrelated deployment**. That replacement
then hits a second problem: CloudFormation creates the new volume attachment before deleting the old
one, so `AttachVolume` fails with `VolumeInUse` and the stack rolls back. A routine deploy becomes a
failed deploy plus a rollback. `cdk synth` emits a warning whenever the pin is missing, and a unit
test asserts `cdk.json` still carries one.

Refreshing it is a deliberate, reviewed one-line change:

```bash
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
  --query Parameter.Value --output text --region ap-south-1
```

Because a refresh replaces the instance, follow
[EC2 replacement](#ec2-replacement-and-reattaching-the-existing-session-volume) when you do it. If
the pinned AMI is wrong for your region, the deploy fails loudly with an AMI-not-found error rather
than silently using something else.

---

## 8. First-time OpenWA authentication

This is the one step nobody can automate: it requires a phone and a human.

**1. Open a tunnel.** The API is published on the instance's loopback interface only, so reach it
through Systems Manager port forwarding — no port is ever opened.

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name OpenwaStack \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

aws ssm start-session --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["2785"],"localPortNumber":["2785"]}'
```

Leave that running. The API is now at `http://localhost:2785`.

**2. Get the admin API key.** On first boot the application seeds its initial ADMIN key from the
Secrets Manager value:

```bash
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name OpenwaStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiMasterKeySecretArn'].OutputValue" --output text)

aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
  --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiMasterKey"])'
```

If that key is rejected, the volume was initialised with a different one. Read the key the
application generated for itself instead, in a separate shell session:

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo cat /opt/openwa/data/.api-key
```

**3. Start the session and scan the QR code.** In a third shell:

```bash
export KEY='<the api key>'
curl -fsS -H "X-API-Key: $KEY" -X POST http://localhost:2785/api/sessions \
  -H 'Content-Type: application/json' -d '{"name":"primary"}'

curl -fsS -H "X-API-Key: $KEY" -X POST http://localhost:2785/api/sessions/primary/start

# Poll until the status is qr_ready, then fetch the QR code.
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/sessions/primary
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/sessions/primary/qr
```

Scan it with WhatsApp on your phone (Settings → Linked devices → Link a device). The bundled
dashboard at `http://localhost:2785/` renders the QR code more comfortably if you prefer.

The session id used here is `primary`, matching `openwa:sessionId` in `cdk.json`. Keep them the same:
the health probe looks for a session by that name.

**4. Confirm it took.**

```bash
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/sessions/primary   # expect status: ready
```

**5. Prove the state is on the persistent volume**, not the root disk:

```bash
aws ssm start-session --target "$INSTANCE_ID"
mountpoint /opt/openwa/data                        # expect: is a mountpoint
sudo find /opt/openwa/data/baileys -name creds.json
```

**6. Prove persistence actually works.** Nothing above demonstrates it. Reboot and check the session
returns with no new QR code:

```bash
aws ec2 reboot-instances --instance-ids "$INSTANCE_ID"
# wait a couple of minutes, re-open the tunnel, then:
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/sessions/primary   # expect status: ready
```

**Until step 6 has been run, treat session persistence as designed-for but unproven.**

---

## 9. Persistent session storage

Everything load-bearing lives on one encrypted EBS volume mounted at `/opt/openwa/data`, bind-mounted
into the container at `/app/data`:

| Path                        | What it is                                                    | Losing it costs      |
| --------------------------- | ------------------------------------------------------------- | -------------------- |
| `baileys/<uuid>/creds.json` | Baileys authentication state                                  | a new QR scan        |
| `sessions/session-<uuid>/`  | whatsapp-web.js profile, if that engine is used               | a new QR scan        |
| `main.sqlite`               | **API keys and the audit log.** Always SQLite, not switchable | every API key        |
| `openwa.sqlite`             | sessions, messages, webhooks, templates                       | message history      |
| `media/`                    | locally stored media                                          | stored media         |
| `plugins/`                  | installed plugins, their registry and state                   | plugin configuration |
| `.api-key`                  | the generated bootstrap admin key, plaintext, mode 0600       | admin access         |
| `.env.generated`            | dashboard-written configuration                               | dashboard settings   |

Note the second row. The repository's own `scripts/backup.sh` documents that backing up only
`sessions/` silently loses every API key, which is why the whole data directory is on the volume
rather than just the session directory.

### How the volume is protected

- `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`, both asserted by the test suite.
- A stand-alone volume, not a block device on the instance, so instance replacement cannot take it.
- Mounted from `/etc/fstab` **by filesystem UUID**. On Nitro instances the requested `/dev/sdf` alias
  is not honoured and the device appears as some `/dev/nvmeXn1`, so a device-name mount would be a
  bug waiting to happen. `bootstrap.sh` resolves the real device with `ebsnvme-id`.
- `bootstrap.sh` runs `mkfs` **only** when `blkid` finds no filesystem. An existing filesystem is
  never reformatted.
- **Docker itself cannot start before the volume is mounted.** `bootstrap.sh` gives `docker.service`
  a drop-in with `RequiresMountsFor=/opt/openwa/data`, and starts Docker only after the mount
  succeeds. This is the structural guard, and it is the one that actually closes the hole: a unit
  dependency on `openwa.service` alone would not, because dockerd can start a container by itself
  through its restart policy, and the `nofail` fstab entry is deliberately _not_ ordered before
  `docker.service`. On a slow EBS attach, dockerd could otherwise come up first, resolve the bind
  mount to the still-empty mountpoint directory on the root disk, and the application would
  initialise a fresh data directory and show a new QR code — indistinguishable from a lost session.
  If the volume genuinely cannot mount, Docker fails to start, the health metrics stop, the alarms
  fire, and the instance is still reachable over SSM. That is the correct outcome.
- **The container's restart policy is `on-failure:5`, not `unless-stopped`.** `unless-stopped` and
  `always` make dockerd start the container when the daemon starts, which routes around
  `openwa.service` and its guards entirely. `on-failure` still recovers a crash — including an OOM
  kill — while leaving the boot path to one place.
- `openwa.service` carries `RequiresMountsFor=/opt/openwa/data` and an `ExecStartPre=mountpoint -q`,
  and `deploy.sh` independently refuses to start unless the path is a mount point. Three guards in
  total, because this is the most plausible route to an apparent session loss.
- `deploy.sh` writes `.openwa-auth-present` the first time it sees authentication state. If that
  marker exists but the state has gone, it **aborts** rather than starting an unauthenticated
  instance that would look like a successful deployment.
- `.gitignore` already excludes `data/`, `.wwebjs_auth/`, `*.sqlite` and `/backups/`, so session data
  cannot be committed.
- Permissions are `0750`, owner `997:997` — the uid the container drops to. The runtime secret is
  written to `/opt/openwa/app/.env.runtime` at mode 0600 on the **root** volume, so it never enters
  an EBS snapshot.

---

## 10. Automatic deployments

Three workflows, deliberately separate.

| Workflow              | Trigger                                                | What it does                                                                   |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `aws-cdk-deploy.yml`  | push to `main` touching `deploy/aws/**`, or manual     | Lint, typecheck, test, validate, then `cdk diff` and `cdk deploy`, then verify |
| `aws-app-deploy.yml`  | automatically after a successful CDK Deploy, or manual | Sends the runtime bundle to the instance over SSM and restarts the container   |
| `aws-cdk-destroy.yml` | manual only, with a typed confirmation                 | Destroys the stack, refusing if the volume's retention has been weakened       |

Both deploy workflows run under the `production` environment, hold `id-token: write` and
`contents: read` and nothing else, use concurrency groups that queue rather than cancel, and pin
every action to a commit SHA. None uses `pull_request_target`.

**The two are chained, not independently triggered.** `aws-app-deploy.yml` fires on
`workflow_run` after CDK Deploy succeeds, and never on a bare push. The reason is that the runtime
bundle reaches the instance through an SSM parameter holding its S3 URL, and only `cdk deploy`
publishes a new bundle and updates that parameter. A push trigger on `deploy/aws/runtime/**` raced
the infrastructure deploy and usually re-applied the _previous_ bundle while reporting success.
Chaining also means a change to `openwa:imageRef` in `cdk.json` actually rolls out: previously it
only rewrote the SSM config parameter and nothing re-ran `deploy.sh` to pull the new image.

So a single push that touches `deploy/aws/**` runs CDK Deploy, and then App Deploy applies whatever
it published. A manual `workflow_dispatch` of App Deploy re-applies the bundle currently published,
which is the right tool for re-running a failed rollout.

> **What automatic deployment does not include.** The deployment runs a digest-pinned _upstream_
> image, so changes to this repository's application source do not reach the instance. If you intend
> to ship fork-local code, you must build and publish your own image and point `openwa:imageRef` at
> it. This is a consequence of choosing the published image, not an oversight.

---

## 11. Health checks

Four states are measured separately, because a green answer to one says nothing about the others.
**An HTTP 200 does not mean WhatsApp is authenticated.**

| State                           | How                                                      | Published as                      |
| ------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Container running               | `docker inspect`                                         | `OpenWA/Health ContainerRunning`  |
| Container restarting repeatedly | `docker inspect` restart count                           | `OpenWA/Health ContainerRestarts` |
| API responding                  | `GET /api/health/live` — static, probes nothing          | the container healthcheck         |
| Dependencies ready              | `GET /api/health/ready` — probes both SQLite connections | `OpenWA/Health ApiReady`          |
| **WhatsApp connected**          | a session reports status `ready`                         | `OpenWA/Health WhatsAppConnected` |

`runtime/healthcheck.sh` runs every five minutes from `openwa-health.timer`, which `install.sh`
enables **and starts** — without starting it, the probe would not run until the next reboot, and
because the two alarms below treat missing data as breaching they would both fire about fifteen
minutes after every deploy while a real outage went unreported. It publishes all of It never logs the API key or the QR payload, and no QR code is ever exposed off the instance.

### Alarms

Six, on purpose rather than a dashboard of everything measurable:

1. `StatusCheckFailed` — instance or system check failing
2. `CPUUtilization` above 85% for 15 minutes
3. `mem_used_percent` above 85% (from the CloudWatch agent; EC2 cannot see memory)
4. `disk_used_percent` on `/opt/openwa/data` above 80%
5. `ApiReady` below 1 for 15 minutes
6. `WhatsAppConnected` below 1 for 15 minutes

The last two treat **missing data as breaching**: if the health probe stops running, that is itself a
failure and must not read as healthy. Alarm 6 is the one that catches a logout, which no AWS signal
would otherwise reveal.

To be notified, set `openwa:alarmEmail` in `cdk.json`, deploy, then confirm the subscription email
AWS sends. Alarms and notifications are billed — see [Cost](#18-cost).

```bash
aws cloudwatch describe-alarms --alarm-name-prefix "$INSTANCE_ID" \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
```

---

## 12. Logs

| Log group                       | Contents                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| `/openwa/OpenwaStack/container` | container stdout, via the Docker `awslogs` driver                  |
| `/openwa/OpenwaStack/system`    | cloud-init, `bootstrap.sh`, `deploy.sh`, from the CloudWatch agent |

Retention defaults to 14 days (`openwa:logRetentionDays`). Both groups are retained when the stack is
destroyed, so the evidence for whatever prompted the destroy survives it.

```bash
# Follow the application log
aws logs tail /openwa/OpenwaStack/container --follow

# What happened during the last deployment
aws logs tail /openwa/OpenwaStack/system --since 1h --filter-pattern 'openwa-deploy'
```

Through Systems Manager, on the instance:

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo docker logs --tail 200 openwa          # still works: Docker's dual-logging cache
sudo tail -n 200 /var/log/openwa-deploy.log
sudo tail -n 200 /var/log/openwa-bootstrap.log
sudo systemctl status openwa.service openwa-health.timer
```

`docker logs` keeps working despite the `awslogs` driver because Docker caches locally as well, so
CloudWatch delivery does not cost you local debuggability.

---

## 13. Backups

**Primary: daily encrypted EBS snapshots**, taken by a Data Lifecycle Manager policy selecting the
volume by its `openwa:backup=true` tag. DLM was chosen over AWS Backup because DLM itself is free —
only snapshot storage is billed — and this is a single-volume problem needing none of AWS Backup's
vaults and plans. Snapshots inherit the volume's encryption and, being read-only point-in-time
copies, never touch or lock the live session.

Configure with `openwa:backupHourUtc` (default 03:00 UTC) and `openwa:backupRetentionCount`
(default 7).

```bash
aws ec2 describe-snapshots --owner-ids self \
  --filters 'Name=tag:openwa:snapshot,Values=dlm-daily' \
  --query 'reverse(sort_by(Snapshots, &StartTime))[:10].[SnapshotId,StartTime,State,VolumeSize]' \
  --output table
```

**Secondary: a logical archive**, for when a block snapshot is the wrong tool — inspecting state,
moving to another volume, restoring one piece. `runtime/backup.sh` calls the application's own
`/app/scripts/backup.sh` inside the container, which is the authority on what state matters:

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo /opt/openwa/app/backup.sh
sudo ls -la /opt/openwa/data/backups
```

> **The archive contains `.api-key` in plaintext**, plus WhatsApp authentication state. Treat it as
> the credentials themselves. Never attach one to a CI artifact, an issue or unencrypted storage. It
> is written inside the encrypted volume for exactly that reason, which does mean snapshots include
> it.

---

## 14. Recovery

### Container crash

`restart: on-failure:5` plus `live-restore` in the Docker daemon handle it. If it is crash-looping,
`ContainerRestarts` climbs and `ApiReady` alarms.

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo docker logs --tail 200 openwa
sudo systemctl restart openwa.service
```

### EC2 reboot

Nothing to do. `openwa.service` is enabled and ordered after the EBS mount, and
`AUTO_START_SESSIONS=true` resumes the authenticated session. This is exactly what step 8.6 verifies.

### EC2 replacement, and reattaching the existing session volume

Changing `userdata/bootstrap.sh`, the AMI or the instance type replaces the instance. The volume is
retained, but CloudFormation may not be able to move the attachment cleanly while the old instance
still holds it. If the deploy stalls on the attachment, or you are rebuilding onto an existing
volume:

```bash
# 1. The volume that must survive
VOLUME_ID=$(aws ec2 describe-volumes --filters 'Name=tag:openwa:backup,Values=true' \
  --query 'Volumes[0].VolumeId' --output text)
aws ec2 describe-volumes --volume-ids "$VOLUME_ID" \
  --query 'Volumes[0].[State,AvailabilityZone,Attachments[0].InstanceId]' --output table

# 2. Stop the container cleanly first, if the old instance is still reachable
aws ssm start-session --target "$OLD_INSTANCE_ID"
sudo systemctl stop openwa.service && exit

# 3. Detach, and WAIT for available. Never attach one writable session volume to two instances.
aws ec2 detach-volume --volume-id "$VOLUME_ID"
aws ec2 wait volume-available --volume-ids "$VOLUME_ID"

# 4. Attach to the new instance and let the deployment re-run
aws ec2 attach-volume --volume-id "$VOLUME_ID" --instance-id "$NEW_INSTANCE_ID" --device /dev/sdf
aws ssm send-command --instance-ids "$NEW_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/bin/openwa-refresh"]'
```

`bootstrap.sh` will see an existing filesystem and preserve it. The new instance must be in the same
availability zone as the volume; the stack pins both to one AZ for this reason.

### Restoring from a snapshot

```bash
SNAPSHOT_ID=<chosen snapshot>
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)

NEW_VOLUME=$(aws ec2 create-volume --snapshot-id "$SNAPSHOT_ID" --availability-zone "$AZ" \
  --volume-type gp3 --encrypted \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=openwa:backup,Value=true},{Key=openwa-managed,Value=true}]' \
  --query VolumeId --output text)
aws ec2 wait volume-available --volume-ids "$NEW_VOLUME"
```

Then stop the container, detach the current volume, attach the restored one at `/dev/sdf`, and run
`openwa-refresh`. Afterwards, import the restored volume into the stack so CDK manages it — or accept
that it is now unmanaged and record that fact.

### Failed deployment

A failed application deployment changes no infrastructure and removes no data. `deploy.sh` captures
redacted diagnostics, rolls back to the previously running image, and exits non-zero. See
[Rollback](#17-rollback).

### WhatsApp session logout

`WhatsAppConnected` alarms. A logout cannot be repaired from the AWS side: it needs a new QR scan.

```bash
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/sessions/primary
curl -fsS -H "X-API-Key: $KEY" -X POST http://localhost:2785/api/sessions/primary/start
# then repeat step 8.3
```

**Nothing in this deployment ever resets the session automatically.** `deploy.sh` would rather fail
loudly than start fresh.

---

## 15. Secret rotation

> **Read this before trying to rotate anything.** `API_MASTER_KEY` is a **first-boot seed only**. The
> application applies it when it initialises an empty data directory and ignores it afterwards; live
> keys are hashed rows in `data/main.sqlite`. **Changing the Secrets Manager value rotates nothing.**
> Rotation goes through the application's own API-key endpoints.

So, to rotate an API key:

```bash
# Through the tunnel from step 8, using a current admin key
curl -fsS -H "X-API-Key: $KEY" http://localhost:2785/api/keys
curl -fsS -H "X-API-Key: $KEY" -X POST http://localhost:2785/api/keys \
  -H 'Content-Type: application/json' -d '{"name":"replacement","role":"ADMIN"}'
# Update every consumer, confirm they work, and only then revoke the old key.
```

Browse the exact routes at `http://localhost:2785/api/docs` with `ENABLE_SWAGGER=true`, or in the
repository's `openapi.json`.

The Secrets Manager value may be rotated for hygiene — nothing reads it after first boot — and doing
so touches no session data. Keep it at 32 characters or more, or a future volume initialised from it
would refuse to boot in production.

> **Never set `API_KEY_PEPPER` after keys exist.** It invalidates every existing key at once. It is
> not set by this deployment, and it should stay that way.

---

## 16. Image upgrades

The image is pinned by digest, so upgrading is an explicit, reviewable change.

```bash
# 1. Resolve the digest of the tag you want
docker buildx imagetools inspect ghcr.io/rmyndharis/openwa:0.24.0 --format '{{.Manifest.Digest}}'

# 2. Put it in cdk.json as openwa:imageRef
#    "openwa:imageRef": "ghcr.io/rmyndharis/openwa@sha256:<digest>"

# 3. Validate, then deploy
cd deploy/aws
bash scripts/validate-config.sh
npx cdk diff OpenwaStack
```

Commit and push. **AWS CDK Deploy** publishes the new runtime config parameter, and **AWS App
Deploy** then runs automatically on its success to pull the image and restart the container — no
second manual step. Updating the digest does not replace the instance, because the digest lives in
the SSM parameter rather than in user data.

`validate-config.sh` and the config loader both reject a reference without `@sha256:`, so a mutable
tag cannot reach the instance.

Before upgrading, check the repository `CHANGELOG.md` for migration notes. The application runs
TypeORM migrations against SQLite on the persistent volume, so **take a snapshot first**:

```bash
aws ec2 create-snapshot --volume-id "$VOLUME_ID" \
  --description "pre-upgrade $(date -I)" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=openwa:sensitive,Value=whatsapp-auth-state}]'
```

---

## 17. Rollback

`deploy.sh` rolls back on its own. It records the running image before pulling, and if the new image
fails to start or never passes `/api/health/ready`, it captures redacted diagnostics, rewrites the
image reference to the previous digest and brings that back up — then exits non-zero so the workflow
fails visibly.

Manually:

```bash
aws ssm start-session --target "$INSTANCE_ID"
cat /opt/openwa/app/.image-previous                 # the last digest that passed
sudo sed -i 's#^OPENWA_IMAGE_REF=.*#OPENWA_IMAGE_REF=<previous digest ref>#' /opt/openwa/app/.env
sudo docker compose --file /opt/openwa/app/compose.yaml up -d
```

Then set `openwa:imageRef` back in `cdk.json` and deploy, so the repository matches reality.

To roll back infrastructure, revert the commit and let **AWS CDK Deploy** run. CloudFormation also
rolls back a failed stack update by itself.

---

## 18. Cost

> **These figures are not verified.** They are rough `ap-south-1` order-of-magnitude numbers for
> orientation only. Prices change and vary by region. Check the
> [AWS Pricing Calculator](https://calculator.aws/) for your region before relying on any of it.

What is billed, recurring:

| Item                | Driver                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| EC2 instance        | `t3.small`, on-demand, 24/7. The single largest line item.                          |
| EBS root volume     | 20 GiB gp3                                                                          |
| EBS session volume  | 20 GiB gp3 — **and it keeps billing after a stack destroy**, because it is retained |
| Public IPv4 address | charged per hour for all public IPv4 since February 2024                            |
| EBS snapshots       | 7 daily snapshots; incremental, so far less than 7 × volume size                    |
| CloudWatch alarms   | 6 alarms                                                                            |
| CloudWatch Logs     | ingestion plus 14 days of storage                                                   |
| Secrets Manager     | 1 secret                                                                            |
| SNS                 | negligible at this volume; free tier usually covers it                              |

Not billed: the VPC, the internet gateway, the DLM policy itself, the SSM Session Manager and Run
Command calls, the IAM roles, and the SSM parameters (standard tier).

Levers, roughly in order of effect: stop the instance when it is not needed (the volume and its
session survive — but WhatsApp will disconnect); reduce `openwa:logRetentionDays`; reduce
`openwa:backupRetentionCount`; shrink `openwa:dataVolumeGib`; consider a Savings Plan or Reserved
Instance if this runs permanently.

Deliberately avoided, and what each would have added: a NAT gateway (an hourly charge plus per-GB
processing — by far the biggest saving here), VPC interface endpoints (hourly, per endpoint, and
seven would be needed), a load balancer (hourly plus capacity units), ECS/EKS, RDS, ElastiCache.

### On instance sizing

`t3.small` with the Baileys engine is a **reasoned choice, not a benchmarked one.** Baileys speaks
the WhatsApp protocol directly over a WebSocket and runs no browser, so it fits 2 GiB with room for
the OS and the CloudWatch agent. `mem_limit` is set to `1400m` rather than the repository's 2g default
precisely because 2g on a 2 GiB host leaves nothing for anything else.

The repository's own sizing table in `docs/10-devops-infrastructure.md` is explicitly unbenchmarked
guidance. If memory alarms fire persistently, the evidence to collect is `mem_used_percent` and
`ContainerRestarts` over a week; the smallest sensible step up is `t3.medium` (4 GiB), set through
`openwa:instanceType`.

**Switching to the `whatsapp-web.js` engine requires a larger instance.** It runs a full Chromium per
session — roughly 1.2–1.8 GiB — which does not fit alongside everything else on 2 GiB. Use
`t3.medium` at least, and raise `mem_limit` with it. Do not instead reduce Chromium's process model:
`--single-process` and `--no-zygote` are unsupported and cause subtle failures.

---

## 19. Security controls

| Control                       | How                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No SSH                        | No ingress rule exists at all. Port 22 is not open, and no key pair is created.                                                                                                               |
| No public API                 | Published on `127.0.0.1:2785` only, and the security group has no ingress rule.                                                                                                               |
| Administration                | Systems Manager Session Manager, authenticated and authorised by IAM, logged by CloudTrail.                                                                                                   |
| Restricted egress             | 443 and 80 outbound, DNS to the VPC resolver, NTP to the Amazon time service. Not "all traffic".                                                                                              |
| Encryption at rest            | Both EBS volumes, the snapshots, and the Secrets Manager secret.                                                                                                                              |
| IMDSv2                        | Required, via the launch template. Blocks the SSRF-to-credentials path.                                                                                                                       |
| No hardcoded credentials      | The key is generated by CloudFormation, stored in Secrets Manager, read by the instance role, and written to a 0600 file on the ephemeral root volume.                                        |
| No secrets in outputs or logs | No output exposes it; `deploy.sh` redacts diagnostics; `curl` receives it through a 0600 config file, never argv, so `ps` cannot show it.                                                     |
| Least-privilege instance role | Session Manager, plus writes to its own two log groups, its own two SSM parameters, its own secret, and `PutMetricData` restricted by namespace condition. Not `CloudWatchAgentServerPolicy`. |
| Least-privilege CI role       | Assumes the CDK bootstrap roles; runs `AWS-RunShellScript` only on instances tagged `openwa-managed=true`. No `AdministratorAccess`.                                                          |
| GitHub OIDC                   | No long-lived AWS keys. Trust restricted to one repository and one environment, with the audience pinned.                                                                                     |
| No privileged Docker          | `read_only: true`, `cap_drop: ALL` with a minimal re-add, `no-new-privileges`, `pids_limit`, non-root via `gosu`.                                                                             |
| Session file permissions      | `0750`, owner `997:997`.                                                                                                                                                                      |
| Retention                     | The volume, its snapshots, the secret and the log groups all survive a stack destroy.                                                                                                         |

Verified by the assertion suite: exactly one instance, both volumes encrypted, retention on delete
and replace, IMDSv2 required, zero ingress rules, no NAT gateway, no load balancer, no ECS/EKS/EFS/
RDS/ElastiCache, log retention set, the OIDC trust policy naming only this repository, and no IAM
statement pairing a wildcard action with a wildcard resource.

### Threat worth stating

Anyone with `ssm:StartSession` on this instance, or who can assume the instance role, can read
`/opt/openwa/data/.api-key` and the WhatsApp authentication state, and can send messages as the
linked account. Treat IAM access to this instance as equivalent to possession of the WhatsApp
account, and audit it accordingly.

---

## 20. Troubleshooting

**`cdk deploy` fails on the bootstrap version parameter.** The account or region is not bootstrapped.
Run [step 4](#4-aws-bootstrap).

**GitHub Actions fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`.** The OIDC
subject does not match. Confirm the job declares `environment: production`, the repository in
`openwa:githubDeployRefs` matches exactly, and `AWS_DEPLOY_ROLE_ARN` is the role from step 5. Inspect
the trust policy:

```bash
aws iam get-role --role-name openwa-github-deploy --query 'Role.AssumeRolePolicyDocument'
```

**`EntityAlreadyExists` for the OIDC provider.** The account already has one. Use
`scripts/bootstrap-github-oidc.sh` and set `openwa:githubOidcProviderArn`. See
[step 5](#5-github-oidc-configuration).

**The instance never appears in Session Manager.** Check the instance has the role, then that egress
on 443 works. `/var/log/openwa-bootstrap.log` is only readable once you can get in, so check the
`/openwa/OpenwaStack/system` log group in CloudWatch, which receives the same content.

```bash
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].[PingStatus,AgentVersion]' --output table
```

**Docker will not start: `Unit docker.service has a dependency on opt-openwa-data.mount`.** This is
intentional, and it is the main structural guard in the deployment: `docker.service` carries a
`RequiresMountsFor=/opt/openwa/data` drop-in, so Docker refuses to run while the session volume is
unmounted rather than letting a container bind to the empty mountpoint directory and initialise a
fresh data directory. Fix the mount, not the drop-in:

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo systemctl status opt-openwa-data.mount
lsblk -f                      # is the volume attached at all?
sudo mount -a && sudo systemctl start docker
```

If the volume is genuinely detached, see
[EC2 replacement](#ec2-replacement-and-reattaching-the-existing-session-volume) before anything else.

**Verification fails with `container=absent` and `cloud_init=running`.** The instance has not
finished provisioning — on a first deploy it is still installing Docker and pulling a large image.
`verify-deployment.sh` already waits up to ten minutes for the container and API, so this means it
took longer than that. Re-run it, or give it longer:

```bash
OPENWA_READY_TIMEOUT=1200 bash scripts/verify-deployment.sh
```

Progress is in the `/openwa/OpenwaStack/system` log group, stream `<instance-id>/cloud-init`. There
is no `CreationPolicy`/`cfn-signal` on the instance, so CloudFormation reports the stack complete
before the software is up; the waiting lives in the verify script instead.

**`deploy.sh` says `/opt/openwa/data is not a mount point`.** This is the guard working. The volume
is not attached or not mounted. Do not force it through: the application would create a fresh empty
data directory and the session would appear lost. Check the attachment, then
`sudo systemctl status opt-openwa-data.mount` and `sudo mount -a`.

**`deploy.sh` says `REFUSING TO DEPLOY`.** The marker records that authentication state existed and
it is gone now. Find out why before anything else. Restoring from a snapshot keeps the session;
removing the marker to force a fresh start costs a QR re-scan and should be a last resort.

**The dashboard loads blank over the tunnel.** That is the CSP upgrading HTTP requests to HTTPS.
`CSP_UPGRADE_INSECURE_REQUESTS=false` is already set in `compose.yaml`; if you changed it, change it
back.

**The API returns 401 with the Secrets Manager key.** Expected if the volume was first initialised
with a different key — the seed applies on first boot only. Use `/opt/openwa/data/.api-key`. See
[section 15](#15-secret-rotation).

**The container is OOM-killed.** Check `mem_used_percent` and `docker inspect`. Almost certainly the
engine is `whatsapp-web.js` on a 2 GiB instance. See [sizing](#on-instance-sizing).

**`cdk diff` wants to replace the instance.** Something changed in `userdata/bootstrap.sh`, the AMI
or the instance type. The volume is retained either way, but read
[EC2 replacement](#ec2-replacement-and-reattaching-the-existing-session-volume) first. If it is an
unintended AMI refresh, check that `openwa:amiId` is still pinned.

---

## 21. Destroying the stack without losing the session

Run the **AWS CDK Destroy** workflow, typing `OpenwaStack` to confirm and giving a reason. It requires
the `production` environment's approval, prints what it will and will not remove, and **refuses to run
if the volume's retention policy has been weakened**.

Locally:

```bash
cd deploy/aws
npx cdk destroy OpenwaStack
```

Survives by design: the EBS session volume, every snapshot, the Secrets Manager secret, and both
CloudWatch log groups.

```bash
aws ec2 describe-volumes --filters 'Name=tag:openwa:backup,Values=true' \
  --query 'Volumes[].[VolumeId,State,Size]' --output table
```

To come back on the same session, redeploy and follow
[EC2 replacement](#ec2-replacement-and-reattaching-the-existing-session-volume) to attach the retained
volume. No new QR scan.

**To remove everything, including the WhatsApp session** — irreversible, needs a new QR scan:

```bash
aws ec2 delete-volume --volume-id "$VOLUME_ID"

aws ec2 describe-snapshots --owner-ids self \
  --filters 'Name=tag:openwa:snapshot,Values=dlm-daily' \
  --query 'Snapshots[].SnapshotId' --output text \
  | tr '\t' '\n' | xargs -r -n1 aws ec2 delete-snapshot --snapshot-id

aws secretsmanager delete-secret --secret-id OpenwaStack/api-master-key \
  --recovery-window-in-days 7

aws logs delete-log-group --log-group-name /openwa/OpenwaStack/container
aws logs delete-log-group --log-group-name /openwa/OpenwaStack/system
```

Each is a separate, deliberate command on purpose. There is no single switch that erases the session.

---

## Configuration reference

Everything lives in the `context` block of `cdk.json`. An empty string means unset. Every value is
validated at synth time, so `cdk synth` is the configuration checker.

| Key                                                      | Default                                               | Notes                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `openwa:region`                                          | `ap-south-1`                                          | Falls back to `CDK_DEFAULT_REGION`                                              |
| `openwa:account`                                         | unset                                                 | Falls back to `CDK_DEFAULT_ACCOUNT`                                             |
| `openwa:instanceType`                                    | `t3.small`                                            | `t3.medium` for `whatsapp-web.js`                                               |
| `openwa:rootVolumeGib`                                   | `20`                                                  | Ephemeral; holds Docker images                                                  |
| `openwa:dataVolumeGib`                                   | `20`                                                  | The retained session volume                                                     |
| `openwa:imageRef`                                        | digest-pinned `0.24.0`                                | **Must** contain `@sha256:`                                                     |
| `openwa:amiId`                                           | pinned                                                | Refresh deliberately; see [step 7](#7-initial-cdk-deployment)                   |
| `openwa:engineType`                                      | `baileys`                                             | or `whatsapp-web.js`, which needs a bigger instance                             |
| `openwa:sessionId`                                       | `primary`                                             | Must match the session you create; the health probe uses it                     |
| `openwa:logRetentionDays`                                | `14`                                                  | Must be a value CloudWatch accepts                                              |
| `openwa:backupRetentionCount`                            | `7`                                                   | Daily snapshots kept                                                            |
| `openwa:backupHourUtc`                                   | `3`                                                   | Snapshot hour, UTC                                                              |
| `openwa:githubOwnerRepo`                                 | `opex-labs-ai/OpenWA`                                 | The only repository that may deploy                                             |
| `openwa:githubDeployRefs`                                | `["repo:opex-labs-ai/OpenWA:environment:production"]` | OIDC `sub` allow-list                                                           |
| `openwa:githubOidcProviderArn`                           | unset                                                 | Set to import an existing account provider                                      |
| `openwa:alarmEmail`                                      | unset                                                 | Needs manual subscription confirmation                                          |
| `openwa:backendSecurityGroupId`                          | unset                                                 | **The only way an ingress rule ever appears.** Opens 2785 from that group alone |
| `openwa:peerVpcId` / `peerVpcCidr` / `peerRouteTableIds` | unset                                                 | Peer one same-region VPC and route both ways. Requires `backendSecurityGroupId` |
| `openwa:privateDnsName`                                  | unset                                                 | Private hosted zone + A record for the instance, visible only in the two VPCs   |

### Reaching the API from an application backend

The default is no inbound access of any kind. Options, in order of preference:

1. **Backend in the same VPC** — set `openwa:backendSecurityGroupId`. One security-group-to-security-group
   rule on 2785, private, no public exposure, no extra cost.
   **Backend in another VPC in the same account and region** — also set `openwa:peerVpcId`,
   `openwa:peerVpcCidr` and `openwa:peerRouteTableIds` (the peer's route tables that need a route
   back). The stack peers the two VPCs and adds a route each way. Set `openwa:privateDnsName` (e.g.
   `openwa.internal`) for a private hosted zone associated with both VPCs, so the backend calls
   `http://openwa.internal:2785`. The name does not resolve, and the port is not reachable, from the
   internet. The peer CIDR must not overlap `10.42.0.0/16`. Committed config uses this for WcsBackend.
2. **Backend elsewhere** — SSM port forwarding (as in step 8) for operational use, or a VPN or
   WireGuard/Tailscale overlay for a standing connection. No AWS ingress rule needed.
3. **Public HTTPS** — an ALB with ACM and the API key enforced. This adds an hourly load balancer
   charge and is the only option that puts the API on the internet. Not implemented here; it needs a
   documented requirement to justify both the cost and the exposure.

Never open 2785 to `0.0.0.0/0`. The API key is the only thing in front of an account that can send
messages as you.

---

## Validation status

Run locally, all passing at the time of writing:

```bash
cd deploy/aws
npm ci
npx tsc --noEmit                 # clean
npm test                         # 56 assertions, all passing
npx cdk synth OpenwaStack        # synthesises
npx cdk synth OpenwaOidcStack    # synthesises
bash scripts/validate-config.sh  # all checks pass
```

Plus, from the repository root: `node scripts/check-dockerignore.mjs`, and `actionlint` over every
workflow (`docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.12 -color`).

**Not exercised:** anything requiring AWS. No stack has been deployed, no instance has booted, no
container has started, and no WhatsApp session has been authenticated. The user-data script, the
volume mount logic, `deploy.sh`, the CloudWatch agent configuration and the alarms have been written
and linted but never run on a live instance. Treat the first deployment as the real test, and work
through step 8 — including the reboot in 8.6 — before relying on any of it.

---

## Limitations

- **Fork-local code is not deployed.** The pinned image is the upstream published one.
- **Instance replacement needs a hand.** On replacement CloudFormation creates the new volume
  attachment before deleting the old one, so `AttachVolume` fails with `VolumeInUse` and the stack
  rolls back. The volume always survives, but the replacement does not complete unattended — follow
  [EC2 replacement](#ec2-replacement-and-reattaching-the-existing-session-volume). Pinning the AMI
  removes the common accidental trigger; what remains are deliberate changes to `openwa:amiId`,
  `openwa:instanceType` or `userdata/bootstrap.sh`. Moving the attach into `bootstrap.sh` (tag
  lookup, wait for `available`, attach) would fix this properly and is the obvious next change, but
  it needs care not to attach one writable session volume to two instances.
- **Single instance, single AZ.** An AZ outage is downtime. This cannot be made highly available: the
  application keeps engine state in memory and must run exactly one replica per session volume.
- **One WhatsApp account.** Supporting a second means a second session on the same instance, with the
  memory implications above, and the health probe currently tracks one session id.
- **An AMI refresh still means an instance replacement.** The AMI is pinned, so this only happens
  when you deliberately bump `openwa:amiId` — but when you do, see the attachment caveat above.

---

## WhatsApp terms and risk

OpenWA is unofficial automation of WhatsApp Web. It is not affiliated with or endorsed by WhatsApp or
Meta. Using it carries a real risk that the linked account is restricted or banned, and that risk sits
with whoever links the account.

Before deploying, review the WhatsApp Terms of Service and Business Messaging Policy and satisfy
yourself that your use complies. If you need a supported, contractual path, that is the official
WhatsApp Business Platform (Cloud API), not this.

Treat the WhatsApp authentication state on the session volume as highly sensitive: it is a credential
that can send messages as the linked account. Do not copy it off the encrypted volume, do not put it
in a CI artifact, and do not share snapshots across accounts.
