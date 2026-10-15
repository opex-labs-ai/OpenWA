import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const STS_AUDIENCE = 'sts.amazonaws.com';

export interface GithubOidcProps {
  /** "owner/repo" of the only repository allowed to assume the role. */
  readonly ownerRepo: string;
  /** Patterns matched against the OIDC `sub` claim with StringLike. */
  readonly subjectPatterns: readonly string[];
  /**
   * ARN of an OIDC provider the account already has. AWS permits exactly one provider per URL per
   * account, so when another project in this account already created it, this must be set and the
   * provider is imported rather than created.
   */
  readonly existingProviderArn?: string;
  /** CDK bootstrap qualifier. Only change it if the account was bootstrapped with a custom one. */
  readonly cdkQualifier?: string;
  readonly roleName: string;
  /**
   * Tag key/value the deploy role may target with ssm:SendCommand. Scoping by tag rather than by
   * instance id keeps this stack independent of the application stack's lifecycle.
   */
  readonly managedInstanceTag: { readonly key: string; readonly value: string };
}

/**
 * GitHub Actions OIDC federation: the provider (created or imported) plus a deployment role that
 * only the named repository can assume.
 *
 * The role deliberately holds NO power to create infrastructure. Everything it can do is assume the
 * CDK bootstrap roles, which is how modern CDK deploys, plus the read and SSM calls the deploy and
 * verify workflows make directly. That keeps `AdministratorAccess` out of anything GitHub can mint
 * a token for.
 */
export class GithubOidc extends Construct {
  public readonly role: iam.Role;
  public readonly providerArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const qualifier = props.cdkQualifier ?? 'hnb659fds';

    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'Imported', props.existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'Provider', {
          url: GITHUB_OIDC_URL,
          clientIds: [STS_AUDIENCE],
        });
    this.providerArn = provider.openIdConnectProviderArn;

    // `aud` is pinned with StringEquals and `sub` with StringLike. Without the aud condition a token
    // minted for any audience would satisfy the policy.
    const principal = new iam.OpenIdConnectPrincipal(provider).withConditions({
      StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: STS_AUDIENCE },
      StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: [...props.subjectPatterns] },
    });

    this.role = new iam.Role(this, 'DeployRole', {
      roleName: props.roleName,
      assumedBy: principal,
      description: `GitHub Actions deployment role for ${props.ownerRepo} (OIDC, no long-lived keys)`,
    });

    // How CDK actually deploys: assume the bootstrap roles, which own the resource-creating rights.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          stack.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: `cdk-${qualifier}-*-${stack.account}-${stack.region}`,
          }),
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCdkBootstrapVersion',
        actions: ['ssm:GetParameter'],
        resources: [
          stack.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `cdk-bootstrap/${qualifier}/version`,
          }),
        ],
      }),
    );

    // Application deploys run a script on the instance through Run Command. SendCommand authorises
    // the document and each target instance separately, hence two statements: the document by ARN,
    // the instances by tag.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunShellScriptDocument',
        actions: ['ssm:SendCommand'],
        resources: [
          stack.formatArn({ service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunCommandOnManagedInstanceOnly',
        actions: ['ssm:SendCommand'],
        resources: [stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
        conditions: {
          StringEquals: { [`ssm:resourceTag/${props.managedInstanceTag.key}`]: props.managedInstanceTag.value },
        },
      }),
    );

    // Read-only status calls the deploy and verify workflows make directly. None of these APIs
    // support resource-level permissions, so the resource is "*" while the action list stays narrow.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadDeploymentStatus',
        actions: [
          'ssm:GetCommandInvocation',
          'ssm:ListCommands',
          'ssm:ListCommandInvocations',
          'ssm:DescribeInstanceInformation',
          'ec2:DescribeInstances',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:ListStacks',
        ],
        resources: ['*'],
      }),
    );
  }
}
