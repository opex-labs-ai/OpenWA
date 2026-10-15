import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** Namespace the host agent publishes memory and disk into. Matches runtime/cloudwatch-agent.json. */
export const HOST_METRIC_NAMESPACE = 'OpenWA/Host';

export interface OpenwaMonitoringProps {
  readonly instance: ec2.Instance;
  /** Namespace healthcheck.sh publishes the four application states into. */
  readonly metricNamespace: string;
  /** Mount path of the persistent volume, used as the `path` dimension of the disk alarm. */
  readonly dataMountPath: string;
  readonly alarmEmail?: string;
}

/**
 * A deliberately small alarm set. Six alarms that each correspond to a failure an operator would
 * want woken for, rather than a dashboard of everything measurable.
 *
 * Alarms and their notifications are billed, which the README states.
 */
export class OpenwaMonitoring extends Construct {
  public readonly topic: sns.Topic;
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: OpenwaMonitoringProps) {
    super(scope, id);

    const instanceId = props.instance.instanceId;
    const dims = { InstanceId: instanceId };

    this.topic = new sns.Topic(this, 'Alarms', {
      displayName: 'OpenWA deployment alarms',
      // SNS enforces TLS for publishes made over HTTPS; this blocks any non-TLS publish path.
      enforceSSL: true,
    });

    if (props.alarmEmail) {
      // Needs the recipient to confirm by email before anything is delivered.
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const action = new cwactions.SnsAction(this.topic);
    const add = (alarm: cloudwatch.Alarm): void => {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      this.alarms.push(alarm);
    };

    // 1. The hypervisor or the guest has stopped answering. Maximum, not Average: either check
    //    failing at all is the signal.
    add(
      new cloudwatch.Alarm(this, 'StatusCheckFailed', {
        alarmName: `${instanceId}-status-check-failed`,
        alarmDescription: 'EC2 instance or system status check failed',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'StatusCheckFailed',
          dimensionsMap: dims,
          statistic: 'Maximum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );

    // 2. Sustained CPU. t3 instances burst, so a short spike is normal and uninteresting; three
    //    consecutive five-minute periods is not.
    add(
      new cloudwatch.Alarm(this, 'CpuHigh', {
        alarmName: `${instanceId}-cpu-high`,
        alarmDescription: 'CPU above 85% for 15 minutes',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          dimensionsMap: dims,
          statistic: 'Average',
          period: Duration.minutes(5),
        }),
        threshold: 85,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // 3. Memory. EC2 cannot report this from the hypervisor, so it comes from the agent.
    add(
      new cloudwatch.Alarm(this, 'MemoryHigh', {
        alarmName: `${instanceId}-memory-high`,
        alarmDescription: 'Memory above 85% — the container is close to its limit',
        metric: new cloudwatch.Metric({
          namespace: HOST_METRIC_NAMESPACE,
          metricName: 'mem_used_percent',
          dimensionsMap: dims,
          statistic: 'Average',
          period: Duration.minutes(5),
        }),
        threshold: 85,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // 4. The persistent volume filling up. A full session volume stops the application writing
    //    authentication state, which is the slow road to a lost session.
    add(
      new cloudwatch.Alarm(this, 'DataVolumeFull', {
        alarmName: `${instanceId}-data-volume-full`,
        alarmDescription: `Persistent volume ${props.dataMountPath} above 80% used`,
        metric: new cloudwatch.Metric({
          namespace: HOST_METRIC_NAMESPACE,
          metricName: 'disk_used_percent',
          dimensionsMap: { InstanceId: instanceId, path: props.dataMountPath },
          statistic: 'Average',
          period: Duration.minutes(5),
        }),
        threshold: 80,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // 5. The API is not serving. Missing data breaches: if the health probe stops running, that is
    //    itself a failure and must not read as healthy.
    add(
      new cloudwatch.Alarm(this, 'ApiNotReady', {
        alarmName: `${instanceId}-api-not-ready`,
        alarmDescription: 'The OpenWA API has not answered /api/health/ready for 15 minutes',
        metric: new cloudwatch.Metric({
          namespace: props.metricNamespace,
          metricName: 'ApiReady',
          dimensionsMap: dims,
          statistic: 'Minimum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );

    // 6. The one the infrastructure cannot otherwise see: every AWS signal can be green while
    //    WhatsApp is logged out and not a single message can be sent.
    add(
      new cloudwatch.Alarm(this, 'WhatsAppDisconnected', {
        alarmName: `${instanceId}-whatsapp-disconnected`,
        alarmDescription:
          'No WhatsApp session has reported status "ready" for 15 minutes. The API being healthy ' +
          'does not imply this; a logged-out session needs a new QR scan.',
        metric: new cloudwatch.Metric({
          namespace: props.metricNamespace,
          metricName: 'WhatsAppConnected',
          dimensionsMap: dims,
          statistic: 'Minimum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );
  }
}
