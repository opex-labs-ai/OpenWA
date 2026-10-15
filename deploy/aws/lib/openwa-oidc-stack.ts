import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { OpenwaConfig } from './config/environment';
import { GithubOidc } from './constructs/github-oidc';

export interface OpenwaOidcStackProps extends StackProps {
  readonly config: OpenwaConfig;
  /** Must match OpenwaStack's MANAGED_TAG so the SendCommand condition matches the instance. */
  readonly managedTag: { readonly key: string; readonly value: string };
}

/**
 * Bootstrap stack: the GitHub OIDC provider and the deployment role.
 *
 * Deployed ONCE, by a human, with administrative credentials — it is the resolution of the
 * chicken-and-egg problem, since the role GitHub Actions uses cannot be created by GitHub Actions.
 * Kept separate from the application stack on purpose: the two have different lifecycles and very
 * different blast radii, and separating them is what keeps elevated bootstrap permissions out of
 * everyday deployment.
 *
 * It is not in the path of a normal deploy, so it is near-static after the first run.
 */
export class OpenwaOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenwaOidcStackProps) {
    super(scope, id, props);

    const { config } = props;

    const oidc = new GithubOidc(this, 'Github', {
      ownerRepo: config.githubOwnerRepo,
      subjectPatterns: config.githubDeployRefs,
      existingProviderArn: config.githubOidcProviderArn,
      roleName: 'openwa-github-deploy',
      managedInstanceTag: props.managedTag,
    });

    new CfnOutput(this, 'DeployRoleArn', {
      value: oidc.role.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN GitHub variable',
    });

    new CfnOutput(this, 'OidcProviderArn', {
      value: oidc.providerArn,
      description:
        'The account GitHub OIDC provider. If another project needs one, pass this as the ' +
        'openwa:githubOidcProviderArn context value rather than creating a second provider.',
    });

    new CfnOutput(this, 'TrustedSubjects', {
      value: config.githubDeployRefs.join(', '),
      description: 'The only OIDC subjects allowed to assume the deployment role',
    });
  }
}
