import * as fs from 'node:fs';
import * as path from 'node:path';

import { Annotations, RemovalPolicy, Size, Stack, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import type { OpenwaConfig } from '../config/environment';

/** Host path the persistent EBS volume is mounted at; bind-mounted to /app/data in the container. */
export const MOUNT_POINT = '/opt/openwa/data';
/** Host path holding the compose file and the deployment scripts. On the ephemeral root volume. */
export const APP_DIR = '/opt/openwa/app';
/** Requested block device alias. Nitro does not honour it — see bootstrap.sh for the resolution. */
const DEVICE_ALIAS = '/dev/sdf';
const FS_LABEL = 'openwa-data';
/** uid/gid the container drops to with gosu, per the image entrypoint. */
const CONTAINER_UID = 997;
const CONTAINER_GID = 997;
const APP_PORT = 2785;
const SWAP_MIB = 1024;

/**
 * Docker Compose v2 is fetched as a binary because Amazon Linux 2023 ships no plugin package.
 * Pinned to an exact release and verified against these checksums, both published by the project.
 */
const COMPOSE_VERSION = 'v2.40.0';
const COMPOSE_SHA_X86 = 'bd5835ccbbf06a42dcb5294c65e34a4634b34447afb9ed6fc7adf18a000e0f99';
const COMPOSE_SHA_ARM = 'fa99ca94c96c8cae4024493581a20049764ce723558991d0d1526c1c7b791a79';

/**
 * Memory ceiling for the container. Deliberately below the repository default of 2g: on a 2 GiB
 * host that default leaves nothing for the kernel, the CloudWatch agent and the Docker daemon.
 * Baileys is single-process and fits comfortably. Raise it together with the instance size if ever
 * switching to the whatsapp-web.js engine, which runs a full Chromium.
 */
const MEM_LIMIT = '1400m';
const PIDS_LIMIT = 2048;

export interface OpenwaEc2Props {
  readonly config: OpenwaConfig;
  readonly containerLogGroup: logs.ILogGroup;
  readonly systemLogGroup: logs.ILogGroup;
  readonly metricNamespace: string;
  /** Tag the GitHub deploy role is allowed to target with ssm:SendCommand. */
  readonly managedTag: { readonly key: string; readonly value: string };
}

/**
 * The compute and storage half of the deployment: one instance, one retained data volume, the
 * instance role, the API-key secret, and the runtime bundle the instance pulls at deploy time.
 */
export class OpenwaEc2 extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly role: iam.Role;
  public readonly instance: ec2.Instance;
  public readonly dataVolume: ec2.Volume;
  public readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: OpenwaEc2Props) {
    super(scope, id);

    const { config } = props;
    const stack = Stack.of(this);

    // ------------------------------------------------------------- network ----
    // One AZ, one public subnet, no NAT Gateway. The instance holds a public IPv4 address purely so
    // the internet gateway can route return traffic for its outbound connections; it is not
    // reachable, because the security group below has no ingress rule at all. The alternative that
    // avoids a public address needs either a NAT Gateway or a set of interface endpoints, and in the
    // endpoint case also a move off GHCR, for an order-of-magnitude higher monthly cost.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
      restrictDefaultSecurityGroup: true,
    });

    const availabilityZone = this.vpc.publicSubnets[0].availabilityZone;

    // Egress is enumerated rather than left open. 443 carries the container registry, the AWS APIs
    // and WhatsApp itself; 80 is kept for package metadata and certificate-status lookups, whose
    // failure modes are obscure and whose exposure, outbound from a single-purpose host, is
    // negligible; 53 reaches the VPC resolver and 123 the Amazon time service.
    this.securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc: this.vpc,
      description: 'OpenWA instance. No ingress by design: administration is via SSM Session Manager.',
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS: GHCR, AWS APIs, WhatsApp');
    this.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP: package metadata, OCSP');
    this.securityGroup.addEgressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.udp(53), 'DNS to the VPC resolver');
    this.securityGroup.addEgressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(53), 'DNS to the VPC resolver');
    this.securityGroup.addEgressRule(ec2.Peer.ipv4('169.254.169.123/32'), ec2.Port.udp(123), 'Amazon Time Sync');

    // The only way an ingress rule ever appears. Left unset, the group has none, so neither SSH nor
    // the application port is reachable from anywhere.
    if (config.backendSecurityGroupId) {
      this.securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(config.backendSecurityGroupId),
        ec2.Port.tcp(APP_PORT),
        'Application backend, private VPC path only',
      );
    }

    // -------------------------------------------------------------- secret ----
    // Generated by CloudFormation, so no human ever sees a production value and nothing lands in a
    // stack output or a workflow log. 48 characters clears the 32-character floor the application
    // enforces in production. Punctuation is excluded to keep the value safe in a shell.
    this.secret = new secretsmanager.Secret(this, 'ApiMasterKey', {
      secretName: `${stack.stackName}/api-master-key`,
      description:
        'Seed for the initial OpenWA ADMIN API key. Applied on FIRST BOOT ONLY: afterwards the live ' +
        'keys are rows in data/main.sqlite and changing this value rotates nothing.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'apiMasterKey',
        passwordLength: 48,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------- persistent data volume ----
    // Stand-alone, NOT a block device on the instance. A block device shares the instance's
    // lifecycle and would be destroyed with it; this one survives instance replacement and stack
    // destruction, which is the single most important property of the whole deployment.
    this.dataVolume = new ec2.Volume(this, 'SessionVolume', {
      availabilityZone,
      size: Size.gibibytes(config.dataVolumeGib),
      encrypted: true,
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      volumeName: `${stack.stackName}-session-data`,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Both policies, explicitly: DeletionPolicy covers `cdk destroy`, UpdateReplacePolicy covers a
    // property change that would otherwise replace the volume. The L2 helper sets DeletionPolicy
    // only, so this reaches through to the CfnVolume to set both.
    (this.dataVolume.node.defaultChild as ec2.CfnVolume).applyRemovalPolicy(RemovalPolicy.RETAIN, {
      applyToUpdateReplacePolicy: true,
    });
    Tags.of(this.dataVolume).add(props.managedTag.key, props.managedTag.value);
    // What the snapshot lifecycle policy selects on.
    Tags.of(this.dataVolume).add('openwa:backup', 'true');

    // ---------------------------------------------------------- instance role ----
    this.role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'OpenWA instance role: Session Manager, its own log groups, its own secret',
      managedPolicies: [
        // Required for Session Manager, which is the only administrative access path.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Written out by hand instead of attaching CloudWatchAgentServerPolicy, which grants log and
    // metric writes across the whole account.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogGroupsOnly',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [
          props.containerLogGroup.logGroupArn,
          `${props.containerLogGroup.logGroupArn}:*`,
          props.systemLogGroup.logGroupArn,
          `${props.systemLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    // PutMetricData has no resource-level control, so the namespace condition is the only way to
    // stop this role writing metrics anywhere else in the account.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishOwnMetricNamespacesOnly',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': [props.metricNamespace, 'OpenWA/Host'] } },
      }),
    );

    this.secret.grantRead(this.role);

    // ------------------------------------------------------- runtime bundle ----
    // The compose file and the scripts travel as an S3 asset rather than being inlined in user
    // data. User data changes replace the instance; this does not, so an operational fix can ship
    // without touching the machine that holds the session.
    const runtimeBundle = new s3assets.Asset(this, 'RuntimeBundle', {
      path: path.join(__dirname, '..', '..', 'runtime'),
    });
    runtimeBundle.grantRead(this.role);

    const bundleParameterName = `/openwa/${stack.stackName}/runtime-bundle-url`;
    const configParameterName = `/openwa/${stack.stackName}/runtime-config`;

    const bundleParameter = new ssm.StringParameter(this, 'RuntimeBundleUrl', {
      parameterName: bundleParameterName,
      stringValue: runtimeBundle.s3ObjectUrl,
      description: 'S3 location of the current OpenWA runtime bundle, read by openwa-refresh.',
    });

    // Everything the instance needs that changes more often than user data: notably the pinned
    // image digest, so a new image does not replace the instance. Holds the secret's ARN, never
    // its value.
    const runtimeConfigParameter = new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: configParameterName,
      description: 'Non-secret runtime configuration for the OpenWA container.',
      stringValue: [
        `OPENWA_IMAGE_REF=${config.imageRef}`,
        `OPENWA_ENGINE_TYPE=${config.engineType}`,
        `OPENWA_SESSION_ID=${config.sessionId}`,
        `OPENWA_SECRET_ARN=${this.secret.secretArn}`,
        `OPENWA_CONTAINER_LOG_GROUP=${props.containerLogGroup.logGroupName}`,
        `OPENWA_SYSTEM_LOG_GROUP=${props.systemLogGroup.logGroupName}`,
        `OPENWA_METRIC_NAMESPACE=${props.metricNamespace}`,
        `OPENWA_PORT=${APP_PORT}`,
        `OPENWA_MEM_LIMIT=${MEM_LIMIT}`,
        `OPENWA_PIDS_LIMIT=${PIDS_LIMIT}`,
        '',
      ].join('\n'),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnRuntimeParameters',
        actions: ['ssm:GetParameter'],
        resources: [
          stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: bundleParameterName.slice(1) }),
          stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: configParameterName.slice(1) }),
        ],
      }),
    );

    // ----------------------------------------------------------- user data ----
    // Kept in its own file so shellcheck can see it and so the substitution is auditable. Note that
    // only stable values are interpolated: the parameter NAMES, never the parameter contents.
    const userData = ec2.UserData.custom(this.renderBootstrap(bundleParameterName, configParameterName, stack.region));

    // ------------------------------------------------------------- instance ----
    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: this.vpc,
      vpcSubnets: { subnets: [this.vpc.publicSubnets[0]] },
      availabilityZone,
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: this.resolveMachineImage(config, stack.region),
      securityGroup: this.securityGroup,
      role: this.role,
      requireImdsv2: true,
      // Basic (five-minute) monitoring. Detailed monitoring is billed per instance and buys nothing
      // here, because the metrics that matter come from the CloudWatch agent.
      detailedMonitoring: false,
      associatePublicIpAddress: true,
      propagateTagsToVolumeOnCreation: true,
      userData,
      // Honest about the consequence: editing bootstrap.sh replaces the machine. The data volume is
      // retained, so the session survives, but the reattachment runbook in the README applies.
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(config.rootVolumeGib, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // Tagged so the GitHub deploy role's ssm:SendCommand condition matches this instance and no
    // other in the account.
    Tags.of(this.instance).add(props.managedTag.key, props.managedTag.value);

    // User data reads both parameters on first boot, so they must exist first.
    this.instance.node.addDependency(bundleParameter, runtimeConfigParameter);

    new ec2.CfnVolumeAttachment(this, 'SessionVolumeAttachment', {
      device: DEVICE_ALIAS,
      instanceId: this.instance.instanceId,
      volumeId: this.dataVolume.volumeId,
    });
  }

  /**
   * An explicitly pinned AMI when one is configured, otherwise the latest Amazon Linux 2023.
   *
   * The pin matters more than it looks. Resolving "latest" on every deploy means an upstream image
   * refresh changes the ImageId, which replaces the instance — during an ordinary, unrelated
   * deployment. The session volume is retained so nothing is lost, but the instance is rebuilt
   * without anyone asking for it. Hence the warning below rather than a silent default.
   */
  private resolveMachineImage(config: OpenwaConfig, region: string): ec2.IMachineImage {
    if (config.amiId) {
      // The default rule set objects to a literal AMI id and asks for a parameter or mapping. Here
      // the literal IS the point: a resolved-at-deploy-time image is what causes the surprise
      // replacement this pin exists to prevent.
      Annotations.of(this).acknowledgeWarning(
        'CloudFormation-Validate::W9010',
        'The AMI is pinned deliberately so an upstream refresh cannot replace the instance.',
      );
      return ec2.MachineImage.genericLinux({ [region]: config.amiId });
    }

    Annotations.of(this).addWarningV2(
      'openwa:unpinned-ami',
      'No openwa:amiId is configured, so this deploy resolves the latest Amazon Linux 2023 AMI. ' +
        'A future upstream refresh will then replace the instance during an unrelated deploy. ' +
        'Pin it after the first deploy: aws ssm get-parameter --name ' +
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 --query Parameter.Value ' +
        '--output text --region ' +
        region +
        '  then set it as openwa:amiId in cdk.json.',
    );
    return ec2.MachineImage.latestAmazonLinux2023();
  }

  /** Substitutes the deployment's stable values into the bootstrap script. */
  private renderBootstrap(bundleParameterName: string, configParameterName: string, region: string): string {
    const source = path.join(__dirname, '..', '..', 'userdata', 'bootstrap.sh');
    const substitutions: Record<string, string> = {
      MOUNT_POINT,
      APP_DIR,
      DEVICE_ALIAS,
      FS_LABEL,
      BUNDLE_PARAM: bundleParameterName,
      CONFIG_PARAM: configParameterName,
      REGION: region,
      COMPOSE_VERSION,
      COMPOSE_SHA_X86,
      COMPOSE_SHA_ARM,
      SWAP_MIB: String(SWAP_MIB),
      RUN_UID: String(CONTAINER_UID),
      RUN_GID: String(CONTAINER_GID),
    };

    let rendered = fs.readFileSync(source, 'utf8');
    for (const [token, value] of Object.entries(substitutions)) {
      rendered = rendered.split(`@@${token}@@`).join(value);
    }

    const unresolved = rendered.match(/@@[A-Z_]+@@/g);
    if (unresolved) {
      throw new Error(`bootstrap.sh has unsubstituted placeholders: ${[...new Set(unresolved)].join(', ')}`);
    }
    return rendered;
  }
}
