#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';

import { resolveConfig } from '../lib/config/environment';
import { OpenwaOidcStack } from '../lib/openwa-oidc-stack';
import { MANAGED_TAG, OpenwaStack } from '../lib/openwa-stack';

const app = new App();

// Throws on any invalid or missing value, which makes `cdk synth` the configuration validator.
const config = resolveConfig(app);

const env = { account: config.account, region: config.region };

// Deployed once by a human with administrative credentials. Creates the role the application stack
// is then deployed with, so it cannot itself be deployed by GitHub Actions.
new OpenwaOidcStack(app, 'OpenwaOidcStack', {
  env,
  config,
  managedTag: MANAGED_TAG,
  description: 'OpenWA bootstrap: GitHub OIDC provider and the least-privilege deployment role',
});

new OpenwaStack(app, 'OpenwaStack', {
  env,
  config,
  description: 'OpenWA on EC2: one instance, Docker, persistent encrypted EBS session storage',
});

Tags.of(app).add('Application', 'openwa');
Tags.of(app).add('ManagedBy', 'aws-cdk');
Tags.of(app).add('Repository', config.githubOwnerRepo);

app.synth();
