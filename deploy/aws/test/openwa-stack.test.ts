import * as fs from 'node:fs';
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { resolveConfig } from '../lib/config/environment';
import { MANAGED_TAG, OpenwaStack } from '../lib/openwa-stack';
import { OpenwaOidcStack } from '../lib/openwa-oidc-stack';

const ACCOUNT = '111122223333';
const REGION = 'ap-south-1';
const OWNER_REPO = 'opex-labs-ai/OpenWA';
const PINNED_IMAGE =
  'ghcr.io/rmyndharis/openwa@sha256:5a2cb7a85e58f33967245dbda174de6aa8c0d0e36d0fced42fb9c6ef83e110d5';

/** Baseline context. An explicit amiId keeps every test hermetic — no AWS lookup, no credentials. */
function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'openwa:account': ACCOUNT,
    'openwa:region': REGION,
    'openwa:instanceType': 't3.small',
    'openwa:rootVolumeGib': 20,
    'openwa:dataVolumeGib': 20,
    'openwa:imageRef': PINNED_IMAGE,
    'openwa:amiId': 'ami-00000000000000001',
    'openwa:engineType': 'baileys',
    'openwa:sessionId': 'primary',
    'openwa:logRetentionDays': 14,
    'openwa:backupRetentionCount': 7,
    'openwa:backupHourUtc': 3,
    'openwa:githubOwnerRepo': OWNER_REPO,
    'openwa:githubDeployRefs': [`repo:${OWNER_REPO}:environment:production`],
    ...overrides,
  };
}

function appStack(overrides: Record<string, unknown> = {}): Template {
  const app = new App({ context: baseContext(overrides) });
  const config = resolveConfig(app);
  return Template.fromStack(new OpenwaStack(app, 'OpenwaStack', { env: { account: ACCOUNT, region: REGION }, config }));
}

function oidcStack(overrides: Record<string, unknown> = {}): Template {
  const app = new App({ context: baseContext(overrides) });
  const config = resolveConfig(app);
  return Template.fromStack(
    new OpenwaOidcStack(app, 'OpenwaOidcStack', {
      env: { account: ACCOUNT, region: REGION },
      config,
      managedTag: MANAGED_TAG,
    }),
  );
}

/** Every IAM statement in a template, from both inline role policies and managed policy documents. */
function allStatements(template: Template): Record<string, unknown>[] {
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: never }>;
  const statements: Record<string, unknown>[] = [];
  for (const resource of Object.values(resources)) {
    const props = (resource.Properties ?? {}) as Record<string, unknown>;
    const docs: unknown[] = [];
    if (props.PolicyDocument) docs.push(props.PolicyDocument);
    if (props.AssumeRolePolicyDocument) docs.push(props.AssumeRolePolicyDocument);
    for (const policy of (props.Policies as { PolicyDocument?: unknown }[] | undefined) ?? []) {
      if (policy.PolicyDocument) docs.push(policy.PolicyDocument);
    }
    for (const doc of docs) {
      const parsed = doc as { Statement?: Record<string, unknown>[] };
      statements.push(...(parsed.Statement ?? []));
    }
  }
  return statements;
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Statements attached to the GitHub deploy role only, excluding CDK's own helper roles. */
function deployRoleActions(template: Template): string[] {
  const resources = template.toJSON().Resources as Record<
    string,
    { Type: string; Properties?: Record<string, unknown> }
  >;
  const roleLogicalId = Object.entries(resources).find(
    ([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties?.RoleName === 'openwa-github-deploy',
  )?.[0];
  expect(roleLogicalId).toBeDefined();

  const actions: string[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;
    const roles = JSON.stringify(resource.Properties?.Roles ?? []);
    if (!roles.includes(roleLogicalId!)) continue;
    const doc = resource.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] };
    for (const statement of doc?.Statement ?? []) {
      actions.push(...asList(statement.Action).filter((a): a is string => typeof a === 'string'));
    }
  }
  expect(actions.length).toBeGreaterThan(0);
  return actions;
}

describe('OpenwaStack: compute', () => {
  it('creates exactly one EC2 instance', () => {
    appStack().resourceCountIs('AWS::EC2::Instance', 1);
  });

  it('uses the configured instance type', () => {
    appStack().hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't3.small' });
  });

  it('honours an overridden instance type', () => {
    appStack({ 'openwa:instanceType': 't3.medium' }).hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.medium',
    });
  });

  it('requires IMDSv2', () => {
    // CDK implements requireImdsv2 through a launch template, so the assertion belongs there rather
    // than on the instance.
    appStack().hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  it('keeps detailed monitoring off, leaving basic monitoring', () => {
    appStack().hasResourceProperties('AWS::EC2::Instance', { Monitoring: false });
  });
});

describe('OpenwaStack: storage and session persistence', () => {
  it('encrypts the root volume', () => {
    appStack().hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }) }),
      ]),
    });
  });

  it('encrypts the persistent data volume', () => {
    appStack().hasResourceProperties('AWS::EC2::Volume', { Encrypted: true, VolumeType: 'gp3', Size: 20 });
  });

  it('honours a configured data volume size', () => {
    appStack({ 'openwa:dataVolumeGib': 50 }).hasResourceProperties('AWS::EC2::Volume', { Size: 50 });
  });

  it('retains the session volume on BOTH delete and replace', () => {
    // The single most important assertion in this file. DeletionPolicy alone would still lose the
    // volume to a property change that forces replacement.
    appStack().hasResource('AWS::EC2::Volume', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('keeps the data volume separate from the instance so it survives replacement', () => {
    const template = appStack();
    template.resourceCountIs('AWS::EC2::Volume', 1);
    template.resourceCountIs('AWS::EC2::VolumeAttachment', 1);
    // Exactly one block device mapping: the root volume. A second would mean the data volume had
    // been attached to the instance's own lifecycle.
    const instances = template.findResources('AWS::EC2::Instance');
    const mappings = Object.values(instances)[0].Properties?.BlockDeviceMappings as unknown[];
    expect(mappings).toHaveLength(1);
  });

  it('tags the volume for the snapshot policy', () => {
    appStack().hasResourceProperties('AWS::EC2::Volume', {
      Tags: Match.arrayWith([Match.objectLike({ Key: 'openwa:backup', Value: 'true' })]),
    });
  });

  it('retains the secret rather than destroying it with the stack', () => {
    appStack().hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain' });
  });
});

describe('OpenwaStack: network exposure', () => {
  it('creates no ingress rule at all by default', () => {
    const template = appStack();
    // Covers "no SSH" and "no public API" in one: there is no rule to argue about.
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    for (const group of Object.values(groups)) {
      expect(group.Properties?.SecurityGroupIngress).toBeUndefined();
    }
  });

  it('opens the API port only to a configured backend security group, never to the world', () => {
    const template = appStack({ 'openwa:backendSecurityGroupId': 'sg-0123456789abcdef0' });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ SourceSecurityGroupId: 'sg-0123456789abcdef0', FromPort: 2785, ToPort: 2785 }),
      ]),
    });
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    for (const group of Object.values(groups)) {
      for (const rule of asList(group.Properties?.SecurityGroupIngress) as Record<string, unknown>[]) {
        expect(rule.CidrIp).toBeUndefined();
        expect(rule.CidrIpv6).toBeUndefined();
      }
    }
  });

  it('never opens port 22', () => {
    const template = appStack({ 'openwa:backendSecurityGroupId': 'sg-0123456789abcdef0' });
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    for (const group of Object.values(groups)) {
      for (const rule of asList(group.Properties?.SecurityGroupIngress) as Record<string, unknown>[]) {
        expect(rule.FromPort).not.toBe(22);
        expect(rule.ToPort).not.toBe(22);
      }
    }
  });

  it('provisions no NAT gateway and no load balancer', () => {
    // Guards the cost promise as much as the security one.
    const template = appStack();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancing::LoadBalancer', 0);
  });

  it('introduces none of the services the deployment is meant to avoid', () => {
    const types = new Set(
      Object.values(appStack().toJSON().Resources as Record<string, { Type: string }>).map(r => r.Type),
    );
    for (const forbidden of [
      'AWS::ECS::Cluster',
      'AWS::ECS::Service',
      'AWS::EKS::Cluster',
      'AWS::EFS::FileSystem',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBCluster',
      'AWS::ElastiCache::CacheCluster',
      'AWS::ElastiCache::ReplicationGroup',
    ]) {
      expect(types).not.toContain(forbidden);
    }
  });
});

describe('OpenwaStack: private access from a peer VPC', () => {
  const PEER = {
    'openwa:backendSecurityGroupId': 'sg-0123456789abcdef0',
    'openwa:peerVpcId': 'vpc-0123456789abcdef0',
    'openwa:peerVpcCidr': '172.31.0.0/16',
    'openwa:peerRouteTableIds': ['rtb-0123456789abcdef0'],
    'openwa:privateDnsName': 'openwa.internal',
  };

  it('creates no peering, route or hosted zone by default', () => {
    const template = appStack();
    template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
  });

  it('peers with the configured VPC and routes both ways', () => {
    const template = appStack(PEER);
    template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 1);
    template.hasResourceProperties('AWS::EC2::VPCPeeringConnection', { PeerVpcId: 'vpc-0123456789abcdef0' });
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '172.31.0.0/16',
      VpcPeeringConnectionId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::EC2::Route', {
      RouteTableId: 'rtb-0123456789abcdef0',
      VpcPeeringConnectionId: Match.anyValue(),
    });
  });

  it('serves the private name only inside the two VPCs', () => {
    const template = appStack(PEER);
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'openwa.internal',
      VPCs: Match.arrayWith([Match.objectLike({ VPCId: 'vpc-0123456789abcdef0' })]),
    });
    const zones = Object.values(template.findResources('AWS::Route53::HostedZone'));
    expect(zones).toHaveLength(1);
    expect((zones[0].Properties.VPCs as unknown[]).length).toBe(2);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'openwa.internal', Type: 'A' });
  });

  it('still opens the API port only to the backend group', () => {
    const template = appStack(PEER);
    for (const group of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
      for (const rule of asList(group.Properties?.SecurityGroupIngress) as Record<string, unknown>[]) {
        expect(rule.CidrIp).toBeUndefined();
      }
    }
  });

  it('binds beyond loopback only when a backend security group is configured', () => {
    const runtimeConfig = (template: Template): string =>
      JSON.stringify(Object.values(template.findResources('AWS::SSM::Parameter')).map(p => p.Properties?.Value));
    expect(runtimeConfig(appStack())).toContain('OPENWA_BIND_ADDRESS=127.0.0.1');
    expect(runtimeConfig(appStack(PEER))).toContain('OPENWA_BIND_ADDRESS=0.0.0.0');
  });

  it('rejects an incomplete or conflicting peer configuration', () => {
    expect(() => appStack({ ...PEER, 'openwa:backendSecurityGroupId': '' })).toThrow(/backendSecurityGroupId/);
    expect(() => appStack({ ...PEER, 'openwa:peerRouteTableIds': [] })).toThrow(/peerRouteTableIds/);
    expect(() => appStack({ ...PEER, 'openwa:peerVpcCidr': '10.42.0.0/16' })).toThrow(/overlaps/);
    expect(() => appStack({ 'openwa:privateDnsName': 'openwa.internal' })).toThrow(/needs peerVpcId/);
  });
});

describe('OpenwaStack: IAM', () => {
  it('gives the instance the Session Manager managed policy', () => {
    appStack().hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore'])]),
        }),
      ]),
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } })]),
      }),
    });
  });

  it('grants no wildcard administrator permission anywhere', () => {
    for (const statement of allStatements(appStack())) {
      if (statement.Effect !== 'Allow') continue;
      const actions = asList(statement.Action).filter((a): a is string => typeof a === 'string');
      const resources = asList(statement.Resource).filter((r): r is string => typeof r === 'string');
      const wildcardAction = actions.some(a => a === '*' || a === 'iam:*' || a === 's3:*');
      const wildcardResource = resources.includes('*');
      expect(wildcardAction && wildcardResource).toBe(false);
    }
  });

  it('scopes PutMetricData to this deployment’s namespaces', () => {
    const matching = allStatements(appStack()).filter(s => asList(s.Action).includes('cloudwatch:PutMetricData'));
    expect(matching).toHaveLength(1);
    expect(matching[0].Condition).toEqual({
      StringEquals: { 'cloudwatch:namespace': ['OpenWA/Health', 'OpenWA/Host'] },
    });
  });

  it('never lets the instance read a secret other than its own', () => {
    const matching = allStatements(appStack()).filter(s => asList(s.Action).includes('secretsmanager:GetSecretValue'));
    expect(matching.length).toBeGreaterThan(0);
    for (const statement of matching) {
      expect(asList(statement.Resource)).not.toContain('*');
    }
  });
});

describe('OpenwaStack: observability and backups', () => {
  it('sets the configured log retention on every log group', () => {
    const template = appStack();
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
      expect(group.Properties?.RetentionInDays).toBe(14);
    }
  });

  it('honours an overridden retention period', () => {
    for (const group of Object.values(
      appStack({ 'openwa:logRetentionDays': 30 }).findResources('AWS::Logs::LogGroup'),
    )) {
      expect(group.Properties?.RetentionInDays).toBe(30);
    }
  });

  it('rejects a retention period CloudWatch does not accept', () => {
    expect(() => appStack({ 'openwa:logRetentionDays': 21 })).toThrow(/not a CloudWatch retention period/);
  });

  it('creates a small, fixed alarm set', () => {
    appStack().resourceCountIs('AWS::CloudWatch::Alarm', 6);
  });

  it('treats a silent health probe as a breach, not as healthy', () => {
    // If the probe stops running, missing data must not read as "fine".
    const alarms = Object.values(appStack().findResources('AWS::CloudWatch::Alarm')).filter(a =>
      ['ApiReady', 'WhatsAppConnected'].includes(a.Properties?.MetricName as string),
    );
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      expect(alarm.Properties?.TreatMissingData).toBe('breaching');
    }
  });

  it('schedules a daily snapshot of the tagged volume with the configured retention', () => {
    appStack().hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      State: 'ENABLED',
      PolicyDetails: Match.objectLike({
        ResourceTypes: ['VOLUME'],
        TargetTags: [{ Key: 'openwa:backup', Value: 'true' }],
        Schedules: Match.arrayWith([
          Match.objectLike({
            CreateRule: Match.objectLike({ Interval: 24, IntervalUnit: 'HOURS', Times: ['03:00'] }),
            RetainRule: { Count: 7 },
          }),
        ]),
      }),
    });
  });
});

describe('OpenwaStack: outputs', () => {
  it('never outputs the API key, only its ARN', () => {
    const outputs = appStack().toJSON().Outputs as Record<string, { Description?: string }>;
    expect(Object.keys(outputs)).toContain('ApiMasterKeySecretArn');
    expect(JSON.stringify(outputs)).not.toMatch(/SecretString|secretValue|unsafeUnwrap/);
  });
});

describe('OpenwaOidcStack: GitHub trust', () => {
  it('restricts the trust policy to the intended repository and environment', () => {
    oidcStack().hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [`repo:${OWNER_REPO}:environment:production`],
              },
            },
          }),
        ]),
      }),
    });
  });

  it('does not trust any other repository', () => {
    const document = JSON.stringify(oidcStack().findResources('AWS::IAM::Role'));
    expect(document).toContain(`repo:${OWNER_REPO}:`);
    expect(document).not.toContain('repo:someone-else/OpenWA');
    // A bare wildcard subject would let any repository in the world assume the role.
    expect(document).not.toMatch(/"token\.actions\.githubusercontent\.com:sub":\s*\["?\*"?\]/);
  });

  it('pins the audience, so a token minted for another audience is rejected', () => {
    const statements = allStatements(oidcStack()).filter(s => s.Action === 'sts:AssumeRoleWithWebIdentity');
    expect(statements).toHaveLength(1);
    expect((statements[0].Condition as Record<string, unknown>).StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    });
  });

  it('accepts the immutable subject format for this repository only', () => {
    const immutable = 'repo:opex-labs-ai@312106196/OpenWA@1420229262:environment:production';
    oidcStack({ 'openwa:githubDeployRefs': [immutable] }).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: { 'token.actions.githubusercontent.com:sub': [immutable] },
            }),
          }),
        ]),
      }),
    });
    expect(() => oidcStack({ 'openwa:githubDeployRefs': ['repo:attacker@1/OpenWA@2:environment:production'] })).toThrow(
      /another repository/,
    );
    expect(() =>
      oidcStack({ 'openwa:githubDeployRefs': ['repo:opex-labs-ai@*/OpenWA@*:environment:production'] }),
    ).toThrow(/another repository/);
  });

  it('refuses a deploy ref belonging to another repository', () => {
    expect(() => oidcStack({ 'openwa:githubDeployRefs': ['repo:attacker/evil:environment:production'] })).toThrow(
      /must start with "repo:opex-labs-ai\/OpenWA:"/,
    );
  });

  it('creates the OIDC provider by default and imports one when told to', () => {
    oidcStack().resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    oidcStack({
      'openwa:githubOidcProviderArn': `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    }).resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('grants the deploy role no AdministratorAccess and no standing write power', () => {
    const template = oidcStack();
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
      const arns = JSON.stringify(role.Properties?.ManagedPolicyArns ?? []);
      expect(arns).not.toContain('AdministratorAccess');
      expect(arns).not.toContain('PowerUserAccess');
    }
    // Scoped to the GitHub deploy role itself. The template also holds CDK's own custom-resource
    // role for creating the OIDC provider, which legitimately has iam:CreateOpenIDConnectProvider
    // and is not assumable from GitHub.
    const actions = deployRoleActions(template);
    expect(actions).toContain('sts:AssumeRole');
    for (const action of actions) {
      expect(action).not.toMatch(/^(ec2|iam|secretsmanager):(Create|Put|Delete|Attach)/);
    }
  });

  it('can only run commands on the instance this deployment tagged', () => {
    const sendCommand = allStatements(oidcStack()).filter(s => asList(s.Action).includes('ssm:SendCommand'));
    // One statement for the document, one for the instances; the instance one must be conditioned.
    expect(sendCommand).toHaveLength(2);
    const instanceScoped = sendCommand.filter(s => JSON.stringify(s.Resource).includes(':instance/'));
    expect(instanceScoped).toHaveLength(1);
    expect(instanceScoped[0].Condition).toEqual({
      StringEquals: { [`ssm:resourceTag/${MANAGED_TAG.key}`]: MANAGED_TAG.value },
    });
  });
});

describe('configuration validation', () => {
  it('rejects a mutable image tag, so a deploy cannot silently change the running code', () => {
    expect(() => appStack({ 'openwa:imageRef': 'ghcr.io/rmyndharis/openwa:latest' })).toThrow(/not digest-pinned/);
  });

  it('accepts only engines the application itself accepts', () => {
    expect(() => appStack({ 'openwa:engineType': 'venom' })).toThrow(/must be one of/);
    expect(() => appStack({ 'openwa:engineType': 'whatsapp-web.js' })).not.toThrow();
  });

  it('rejects a malformed instance type, AMI id, email and security group id', () => {
    expect(() => appStack({ 'openwa:instanceType': 'small' })).toThrow(/not an EC2 instance type/);
    expect(() => appStack({ 'openwa:amiId': 'i-123' })).toThrow(/not an AMI id/);
    expect(() => appStack({ 'openwa:alarmEmail': 'nope' })).toThrow(/not an email address/);
    expect(() => appStack({ 'openwa:backendSecurityGroupId': 'vpc-1' })).toThrow(/not a security group id/);
  });

  it('rejects an out-of-range backup hour and volume size', () => {
    expect(() => appStack({ 'openwa:backupHourUtc': 24 })).toThrow(/between 0 and 23/);
    expect(() => appStack({ 'openwa:dataVolumeGib': 4 })).toThrow(/between 8 and 16384/);
  });
});

describe('runtime bundle', () => {
  const runtime = path.join(__dirname, '..', 'runtime');
  const read = (file: string): string => fs.readFileSync(path.join(runtime, file), 'utf8');

  it('publishes the API port on loopback unless the stack opens it to a backend', () => {
    const compose = read('compose.yaml');
    expect(compose).toContain("'${OPENWA_BIND_ADDRESS:-127.0.0.1}:${OPENWA_PORT}:2785'");
    expect(compose).not.toMatch(/['"]0\.0\.0\.0:\d+:\d+['"]/);
    // A bare "port:port" mapping publishes on every interface.
    expect(compose).not.toMatch(/^\s*-\s*['"]?\d+:2785['"]?\s*$/m);
  });

  it('sets a non-empty engine, because an empty value selects Chromium', () => {
    expect(read('compose.yaml')).toContain("ENGINE_TYPE: '${OPENWA_ENGINE_TYPE}'");
  });

  it('bakes no credential into the compose file', () => {
    const compose = read('compose.yaml');
    expect(compose).not.toMatch(/API_MASTER_KEY\s*:/);
    expect(compose).toContain('.env.runtime');
  });

  it('never removes volumes while deploying', () => {
    for (const file of ['deploy.sh', 'install.sh', 'backup.sh']) {
      const script = read(file);
      expect(script).not.toMatch(/down\s+(-\w+\s+)*-v\b/);
      expect(script).not.toMatch(/down\s+--volumes/);
      expect(script).not.toMatch(/\bmkfs\b/);
      expect(script).not.toMatch(/rm\s+-rf\s+.*\$\{?DATA_DIR/);
    }
  });

  it('refuses to deploy onto a missing mount or a wiped session', () => {
    const deploy = read('deploy.sh');
    expect(deploy).toContain('mountpoint -q "$DATA_DIR"');
    expect(deploy).toContain('REFUSING TO DEPLOY');
  });

  it('passes the API key by config file rather than on a command line', () => {
    // The helper lives in one place now. It was duplicated in both scripts and had already drifted,
    // which is how a security property ends up true in one copy and not the other.
    expect(read('lib-openwa.sh')).toContain('curl --config');
    for (const file of ['deploy.sh', 'healthcheck.sh']) {
      const script = read(file);
      expect(script).toContain('lib-openwa.sh');
      expect(script).toContain('openwa_curl_with_key');
      // No local redefinition: that is what allowed the two copies to diverge.
      expect(script).not.toMatch(/^curl_with_key\(\)/m);
      // The key must never appear as an -H argument, where `ps` would expose it.
      expect(script).not.toMatch(/-H\s+["']X-API-Key:\s*\$/);
    }
  });

  it('formats the data volume only when it has no filesystem', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'userdata', 'bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain('if blkid -p "$DEVICE"');
    expect(bootstrap).toContain('preserving it, not formatting');
    // Mounted by UUID: Nitro does not honour the requested device name.
    expect(bootstrap).toContain('UUID=%s %s ext4');
  });

  it('orders the container start after the persistent mount', () => {
    expect(read('openwa.service')).toContain('RequiresMountsFor=@@DATA_DIR@@');
  });

  // The failure these three guard against: dockerd starting the container by itself on boot,
  // before the EBS volume is mounted, so the bind mount resolves to the empty mountpoint directory
  // on the root disk and the application initialises a fresh data directory. That is
  // indistinguishable from a lost session, and it is the whole reason this deployment exists in
  // this shape.
  it('does not let dockerd start the container on its own', () => {
    const compose = read('compose.yaml');
    expect(compose).not.toMatch(/^\s*restart:\s*(unless-stopped|always)\s*$/m);
    // on-failure still recovers a crash, which the deployment requires, without owning the boot path.
    expect(compose).toMatch(/^\s*restart:\s*on-failure(:\d+)?\s*$/m);
  });

  it('makes the data mount a precondition of docker.service itself', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'userdata', 'bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain('docker.service.d/10-openwa-data-mount.conf');
    expect(bootstrap).toContain('RequiresMountsFor=${MOUNT_POINT}');
  });

  it('starts docker only after the volume is mounted', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'userdata', 'bootstrap.sh'), 'utf8');
    const mounted = bootstrap.indexOf('mounted ${MOUNT_POINT} (UUID');
    const dockerStart = bootstrap.indexOf('systemctl enable --now docker');
    expect(mounted).toBeGreaterThan(0);
    expect(dockerStart).toBeGreaterThan(0);
    // Ordering within the script is the assertion: enabling docker before the mount is the bug.
    expect(dockerStart).toBeGreaterThan(mounted);
  });

  it('starts the health timer, not merely enables it', () => {
    // Without --now the probe would not run until the next reboot, and because ApiReady and
    // WhatsAppConnected treat missing data as breaching, both alarms would fire ~15 minutes after
    // every deploy while a real outage went unreported.
    expect(read('install.sh')).toContain('systemctl enable --now openwa-health.timer');
  });

  it('refuses to call a rolled-back stack a successful deployment', () => {
    const verify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-deployment.sh'), 'utf8');
    expect(verify).toMatch(/UPDATE_ROLLBACK_COMPLETE \| ROLLBACK_COMPLETE\)/);
    expect(verify).not.toMatch(/CREATE_COMPLETE \| UPDATE_COMPLETE \| UPDATE_ROLLBACK_COMPLETE/);
  });

  it('waits for readiness instead of sampling once', () => {
    // There is no CreationPolicy/cfn-signal on the instance, so a single sample would fail the
    // first deployment while cloud-init was still pulling the image.
    const verify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-deployment.sh'), 'utf8');
    expect(verify).toContain('OPENWA_READY_TIMEOUT');
    expect(verify).toContain('cloud_init=');
  });
});

describe('instance-side inputs that fail only at boot', () => {
  it('keeps the CloudWatch agent config free of keys the agent schema rejects', () => {
    // The agent refuses unknown properties, which aborts install.sh and leaves no container running.
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          keys.push(key);
          walk(value);
        }
      }
    };
    walk(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'cloudwatch-agent.json'), 'utf8')));
    expect(keys.filter(key => key.startsWith('_'))).toEqual([]);
  });

  it('sends the verify probe as a JSON parameters object, not the commands= shorthand', () => {
    const verify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-deployment.sh'), 'utf8');
    expect(verify).toContain('json.dumps({"commands": [sys.stdin.read()]})');
    expect(verify).not.toMatch(/--parameters "commands=\$\(/);
  });

  it('reports every probe field on a single line', () => {
    // `docker inspect` on a missing container writes a blank line to stdout and then fails, so an
    // unguarded `|| echo absent` split the field across two lines and the parser read it as empty —
    // producing "the container is , not running".
    const verify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-deployment.sh'), 'utf8');
    expect(verify).toContain('field_or()');
    // Code only: the comment above field_or quotes the old pattern on purpose.
    const code = verify
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/docker inspect[^\n]*\|\| echo (absent|none|0)\)/);
  });

  it('does not let a CloudWatch agent failure abort the deployment', () => {
    // The agent is observability; the container is the service. A rejected agent config used to
    // abort install.sh under `set -e` before the container, the health timer or log shipping had
    // started, which is how one unknown JSON key took the whole deployment down.
    const install = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'install.sh'), 'utf8');
    expect(install).toContain('agent_ok');
    expect(install).toMatch(/Metrics and log shipping are DEGRADED/);
    // The ctl invocation must be inside a conditional, never a bare statement under errexit.
    expect(install).not.toMatch(/^\/opt\/aws\/amazon-cloudwatch-agent\/bin\/amazon-cloudwatch-agent-ctl/m);
  });
});

describe('the deploy workflow applies what it publishes', () => {
  const workflow = (name: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');

  it('applies the runtime bundle before verifying it', () => {
    // `cdk deploy` publishes the bundle and the SSM pointer, but nothing on the instance re-reads
    // that pointer by itself — user data runs once, at first boot. Verifying without applying
    // reports the OLD bundle as a successful deployment of the new one, and a first boot that
    // failed could never be repaired by a later deploy.
    const deploy = workflow('aws-cdk-deploy.yml');
    const apply = deploy.indexOf('apply-runtime-bundle.sh');
    const verify = deploy.indexOf('verify-deployment.sh');
    expect(apply).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(0);
    expect(apply).toBeLessThan(verify);
  });

  it('shares one apply script between the two workflows so they cannot drift', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'scripts', 'apply-runtime-bundle.sh'))).toBe(true);
    expect(workflow('aws-app-deploy.yml')).toContain('apply-runtime-bundle.sh');
  });

  it('does not chain app deploy off the deploy workflow', () => {
    // Chaining on CDK Deploy's success deadlocked: a failed first boot meant no container, so
    // verification failed, so CDK Deploy failed, so the chained rollout never ran, so the fix was
    // never applied. CDK Deploy now applies the bundle itself; this stays a manual tool.
    expect(workflow('aws-app-deploy.yml')).not.toContain('workflow_run');
  });

  it('waits for cloud-init before applying, so two rollouts cannot race', () => {
    const apply = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-runtime-bundle.sh'), 'utf8');
    expect(apply).toContain('cloud-init status');
    expect(apply).toContain('/usr/local/bin/openwa-refresh');
  });
});

describe('committed configuration', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  };

  it('pins the image to a digest', () => {
    expect(String(cdkJson.context['openwa:imageRef'])).toContain('@sha256:');
  });

  it('pins the AMI', () => {
    // An unpinned AMI means any new AL2023 release replaces the instance on the next deploy, and
    // CloudFormation creates the replacement volume attachment before deleting the old one, so that
    // replacement fails with VolumeInUse and rolls the stack back.
    expect(String(cdkJson.context['openwa:amiId'])).toMatch(/^ami-[0-9a-f]{8,}$/);
  });

  it('keeps the engine and session id non-empty', () => {
    // An empty ENGINE_TYPE silently selects the Chromium engine, which does not fit this instance.
    expect(cdkJson.context['openwa:engineType']).toBe('baileys');
    expect(String(cdkJson.context['openwa:sessionId'])).not.toBe('');
  });
});
