import type { App } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Engines the application actually accepts. Mirrors the enum enforced at boot in
 * src/config/env.validation.ts — keep the two in step.
 */
export const ENGINE_TYPES = ['baileys', 'whatsapp-web.js'] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

/** Retention periods CloudWatch Logs accepts. Anything else is rejected at deploy time by the API. */
const CLOUDWATCH_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
] as const;

export interface OpenwaConfig {
  /** Target account. Falls back to CDK_DEFAULT_ACCOUNT; may be undefined for `cdk synth` alone. */
  readonly account?: string;
  readonly region: string;
  readonly instanceType: string;
  readonly rootVolumeGib: number;
  readonly dataVolumeGib: number;
  /** Digest-pinned image reference. A mutable tag is rejected on purpose. */
  readonly imageRef: string;
  readonly engineType: EngineType;
  /** Session id the runtime uses. Must be stable across restarts or the auth state is orphaned. */
  readonly sessionId: string;
  /**
   * Explicit AMI id. Strongly recommended once deployed: left unset, every deploy resolves the
   * latest Amazon Linux 2023 image, and an upstream refresh then replaces the instance silently.
   */
  readonly amiId?: string;
  readonly logRetentionDays: number;
  readonly backupRetentionCount: number;
  readonly backupHourUtc: number;
  readonly githubOwnerRepo: string;
  /** Allow-list matched against the GitHub OIDC `sub` claim. */
  readonly githubDeployRefs: readonly string[];
  /** Set to import an OIDC provider the account already has, instead of creating a second one. */
  readonly githubOidcProviderArn?: string;
  readonly alarmEmail?: string;
  /**
   * When set, and only then, port 2785 is opened from this security group. Left unset the instance
   * has no ingress rule of any kind.
   */
  readonly backendSecurityGroupId?: string;
  /**
   * Private path from another VPC in the same account and region. When set, the two VPCs are peered,
   * each side gets a route to the other, and backendSecurityGroupId must name the caller's group.
   */
  readonly peer?: {
    readonly vpcId: string;
    readonly cidr: string;
    /** Route tables in the peer VPC that need a route back to this VPC. */
    readonly routeTableIds: readonly string[];
  };
  /**
   * Name resolvable only inside this VPC and the peer VPC, pointing at the instance's private IP.
   * Requires peer.
   */
  readonly privateDnsName?: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`openwa deployment config: ${message}`);
    this.name = 'ConfigError';
  }
}

function raw(app: App, key: string): unknown {
  return app.node.tryGetContext(`openwa:${key}`);
}

function requiredString(app: App, key: string, fallback?: string): string {
  const value = raw(app, key) ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`context "openwa:${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(app: App, key: string): string | undefined {
  const value = raw(app, key);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`context "openwa:${key}" must be a string when set`);
  }
  return value.trim();
}

function integer(app: App, key: string, fallback: number, min: number, max: number): number {
  const value = raw(app, key) ?? fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`context "openwa:${key}" must be an integer between ${min} and ${max}, got ${String(value)}`);
  }
  return parsed;
}

/**
 * Resolves and validates every tunable from `cdk.json` context. Every failure throws, which makes
 * `cdk synth` the configuration validator — a bad value never reaches CloudFormation.
 */
export function resolveConfig(app: App): OpenwaConfig {
  const region = requiredString(app, 'region', process.env.CDK_DEFAULT_REGION);
  const account = optionalString(app, 'account') ?? process.env.CDK_DEFAULT_ACCOUNT;

  const instanceType = requiredString(app, 'instanceType', 't3.small');
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(instanceType)) {
    throw new ConfigError(`instanceType "${instanceType}" is not an EC2 instance type such as "t3.small"`);
  }

  const imageRef = requiredString(app, 'imageRef');
  if (!imageRef.includes('@sha256:')) {
    throw new ConfigError(
      `imageRef "${imageRef}" is not digest-pinned. Use "repository@sha256:<digest>" so a deploy ` +
        'cannot silently change the running code. Resolve a tag with: ' +
        'docker buildx imagetools inspect <repo>:<tag>',
    );
  }

  const engineType = requiredString(app, 'engineType', 'baileys');
  if (!(ENGINE_TYPES as readonly string[]).includes(engineType)) {
    throw new ConfigError(`engineType "${engineType}" must be one of ${ENGINE_TYPES.join(', ')}`);
  }

  const sessionId = requiredString(app, 'sessionId', 'primary');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sessionId)) {
    throw new ConfigError(`sessionId "${sessionId}" must be lowercase alphanumeric with hyphens, 1-63 chars`);
  }

  const logRetentionDays = integer(app, 'logRetentionDays', 14, 1, 3653);
  if (!(CLOUDWATCH_RETENTION_DAYS as readonly number[]).includes(logRetentionDays)) {
    throw new ConfigError(
      `logRetentionDays ${logRetentionDays} is not a CloudWatch retention period. ` +
        `Valid values: ${CLOUDWATCH_RETENTION_DAYS.join(', ')}`,
    );
  }

  const githubOwnerRepo = requiredString(app, 'githubOwnerRepo');
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubOwnerRepo)) {
    throw new ConfigError(`githubOwnerRepo "${githubOwnerRepo}" must be "owner/repo"`);
  }

  const refs = raw(app, 'githubDeployRefs');
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new ConfigError('githubDeployRefs must be a non-empty array of OIDC subject patterns');
  }
  // Repositories using GitHub's immutable OIDC subject format get `repo:<owner>@<id>/<repo>@<id>:`
  // instead of `repo:<owner>/<repo>:`. The numeric ids are what make it immutable, so they are
  // required rather than wildcarded.
  const [owner, repo] = githubOwnerRepo.split('/');
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const immutablePrefix = new RegExp(`^repo:${escape(owner)}@\\d+/${escape(repo)}@\\d+:`);
  const githubDeployRefs = refs.map(ref => {
    if (typeof ref !== 'string' || !(ref.startsWith(`repo:${githubOwnerRepo}:`) || immutablePrefix.test(ref))) {
      throw new ConfigError(
        `githubDeployRefs entry ${JSON.stringify(ref)} must start with "repo:${githubOwnerRepo}:" or ` +
          `"repo:${owner}@<id>/${repo}@<id>:" so the trust policy cannot be satisfied by another repository`,
      );
    }
    return ref;
  });

  const amiId = optionalString(app, 'amiId');
  if (amiId !== undefined && !/^ami-[0-9a-f]{8,}$/.test(amiId)) {
    throw new ConfigError(`amiId "${amiId}" is not an AMI id`);
  }

  const alarmEmail = optionalString(app, 'alarmEmail');
  if (alarmEmail !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alarmEmail)) {
    throw new ConfigError(`alarmEmail "${alarmEmail}" is not an email address`);
  }

  const backendSecurityGroupId = optionalString(app, 'backendSecurityGroupId');
  if (backendSecurityGroupId !== undefined && !/^sg-[0-9a-f]{8,}$/.test(backendSecurityGroupId)) {
    throw new ConfigError(`backendSecurityGroupId "${backendSecurityGroupId}" is not a security group id`);
  }

  const peerVpcId = optionalString(app, 'peerVpcId');
  const peerVpcCidr = optionalString(app, 'peerVpcCidr');
  const rawRouteTables = raw(app, 'peerRouteTableIds') ?? [];
  if (
    !Array.isArray(rawRouteTables) ||
    rawRouteTables.some(id => typeof id !== 'string' || !/^rtb-[0-9a-f]{8,}$/.test(id))
  ) {
    throw new ConfigError('peerRouteTableIds must be an array of route table ids');
  }
  const peerRouteTableIds = rawRouteTables as string[];
  let peer: OpenwaConfig['peer'];
  if (peerVpcId !== undefined || peerVpcCidr !== undefined || peerRouteTableIds.length > 0) {
    if (peerVpcId === undefined || !/^vpc-[0-9a-f]{8,}$/.test(peerVpcId)) {
      throw new ConfigError('peerVpcId must be a VPC id when any peer setting is given');
    }
    if (peerVpcCidr === undefined || !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(peerVpcCidr)) {
      throw new ConfigError('peerVpcCidr must be an IPv4 CIDR when peerVpcId is set');
    }
    if (peerVpcCidr.startsWith('10.42.')) {
      throw new ConfigError(`peerVpcCidr ${peerVpcCidr} overlaps this deployment's 10.42.0.0/16`);
    }
    if (peerRouteTableIds.length === 0) {
      throw new ConfigError('peerRouteTableIds must list the peer route tables that need a route back');
    }
    if (backendSecurityGroupId === undefined) {
      throw new ConfigError('peering without backendSecurityGroupId opens a route but no port; set both');
    }
    peer = { vpcId: peerVpcId, cidr: peerVpcCidr, routeTableIds: peerRouteTableIds };
  }

  const privateDnsName = optionalString(app, 'privateDnsName');
  if (privateDnsName !== undefined) {
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(privateDnsName)) {
      throw new ConfigError(`privateDnsName "${privateDnsName}" is not a DNS name`);
    }
    if (peer === undefined) {
      throw new ConfigError('privateDnsName needs peerVpcId: the name only resolves inside associated VPCs');
    }
  }

  return {
    account,
    region,
    instanceType,
    rootVolumeGib: integer(app, 'rootVolumeGib', 20, 8, 1024),
    dataVolumeGib: integer(app, 'dataVolumeGib', 20, 8, 16384),
    imageRef,
    amiId,
    engineType: engineType as EngineType,
    sessionId,
    logRetentionDays,
    backupRetentionCount: integer(app, 'backupRetentionCount', 7, 1, 1000),
    backupHourUtc: integer(app, 'backupHourUtc', 3, 0, 23),
    githubOwnerRepo,
    githubDeployRefs,
    githubOidcProviderArn: optionalString(app, 'githubOidcProviderArn'),
    alarmEmail,
    backendSecurityGroupId,
    peer,
    privateDnsName,
  };
}

/** Maps a validated retention value onto the CDK enum. */
export function toRetentionDays(days: number): RetentionDays {
  const match = Object.entries(RetentionDays).find(([, value]) => value === days);
  if (!match) {
    throw new ConfigError(`no RetentionDays enum member for ${days} days`);
  }
  return match[1] as RetentionDays;
}
