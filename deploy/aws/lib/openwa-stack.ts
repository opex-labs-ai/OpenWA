import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import { type OpenwaConfig, toRetentionDays } from './config/environment';
import { OpenwaBackup } from './constructs/openwa-backup';
import { MOUNT_POINT, OpenwaEc2 } from './constructs/openwa-ec2';
import { OpenwaMonitoring } from './constructs/openwa-observability';

/** Namespace runtime/healthcheck.sh publishes the four application states into. */
const HEALTH_METRIC_NAMESPACE = 'OpenWA/Health';

/**
 * Tag used in two places: the GitHub deploy role's ssm:SendCommand condition, so it can only run
 * commands on this instance, and as a general marker. The key avoids a colon because it is embedded
 * in an IAM condition key (`ssm:resourceTag/...`).
 */
export const MANAGED_TAG = { key: 'openwa-managed', value: 'true' } as const;

export interface OpenwaStackProps extends StackProps {
  readonly config: OpenwaConfig;
}

/**
 * The application stack: network, instance, retained session volume, secret, logs, alarms, backups.
 *
 * Deployed by GitHub Actions through the role created by OpenwaOidcStack. It creates no IAM identity
 * that a CI system could use, and no resource that exposes the application to the internet.
 */
export class OpenwaStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenwaStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Retained on destroy: logs are the evidence trail for whatever prompted the destroy, and they
    // are not session data, so keeping them costs little and loses nothing.
    const containerLogGroup = new logs.LogGroup(this, 'ContainerLogs', {
      logGroupName: `/openwa/${this.stackName}/container`,
      retention: toRetentionDays(config.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const systemLogGroup = new logs.LogGroup(this, 'SystemLogs', {
      logGroupName: `/openwa/${this.stackName}/system`,
      retention: toRetentionDays(config.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const compute = new OpenwaEc2(this, 'Compute', {
      config,
      containerLogGroup,
      systemLogGroup,
      metricNamespace: HEALTH_METRIC_NAMESPACE,
      managedTag: MANAGED_TAG,
    });

    new OpenwaMonitoring(this, 'Monitoring', {
      instance: compute.instance,
      metricNamespace: HEALTH_METRIC_NAMESPACE,
      dataMountPath: MOUNT_POINT,
      alarmEmail: config.alarmEmail,
    });

    new OpenwaBackup(this, 'Backup', {
      volumeTag: { key: 'openwa:backup', value: 'true' },
      retentionCount: config.backupRetentionCount,
      hourUtc: config.backupHourUtc,
      policyDescription: `Daily snapshots of the ${this.stackName} OpenWA session volume`,
    });

    // ------------------------------------------------------------- outputs ----
    // Deliberately absent: the API key. CloudFormation never emits a generated secret value, and
    // adding an output for it would put it in `cdk deploy` output and workflow logs.
    new CfnOutput(this, 'InstanceId', {
      value: compute.instance.instanceId,
      description: 'Instance id, used as the SSM Session Manager target',
    });

    new CfnOutput(this, 'DataVolumeId', {
      value: compute.dataVolume.volumeId,
      description: 'Persistent session volume. Retained on stack destroy and instance replacement.',
    });

    new CfnOutput(this, 'ApiMasterKeySecretArn', {
      value: compute.secret.secretArn,
      description: 'ARN (not the value) of the first-boot API key seed in Secrets Manager',
    });

    new CfnOutput(this, 'ContainerLogGroup', {
      value: containerLogGroup.logGroupName,
      description: 'CloudWatch log group carrying the container stdout',
    });

    new CfnOutput(this, 'SystemLogGroup', {
      value: systemLogGroup.logGroupName,
      description: 'CloudWatch log group carrying bootstrap, deploy and cloud-init output',
    });

    new CfnOutput(this, 'SessionManagerCommand', {
      value: `aws ssm start-session --target ${compute.instance.instanceId} --region ${this.region}`,
      description: 'Interactive shell on the instance. There is no SSH access and no open port 22.',
    });

    new CfnOutput(this, 'PortForwardCommand', {
      value:
        `aws ssm start-session --target ${compute.instance.instanceId} --region ${this.region}` +
        ' --document-name AWS-StartPortForwardingSession' +
        ' --parameters \'{"portNumber":["2785"],"localPortNumber":["2785"]}\'',
      description: 'Reach the API at http://localhost:2785 without exposing any port publicly',
    });
  }
}
