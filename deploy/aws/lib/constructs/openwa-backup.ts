import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface OpenwaBackupProps {
  /** Tag key/value selecting the volumes to snapshot. */
  readonly volumeTag: { readonly key: string; readonly value: string };
  readonly retentionCount: number;
  readonly hourUtc: number;
  readonly policyDescription: string;
}

/**
 * Daily encrypted snapshots of the session volume, via Data Lifecycle Manager.
 *
 * DLM rather than AWS Backup: DLM has no charge of its own — only the snapshot storage is billed —
 * and this is a single-volume problem that needs none of AWS Backup's cross-service vaults, plans
 * and selections. Snapshots inherit the volume's encryption, and being read-only point-in-time
 * copies they never modify or lock the live session.
 */
export class OpenwaBackup extends Construct {
  public readonly policy: dlm.CfnLifecyclePolicy;

  constructor(scope: Construct, id: string, props: OpenwaBackupProps) {
    super(scope, id);

    // DLM assumes this role to take and expire snapshots. Scoped to the managed policy AWS
    // publishes for exactly this purpose rather than a hand-rolled set.
    const role = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      description: 'Data Lifecycle Manager role for OpenWA session volume snapshots',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    });

    const startTime = `${String(props.hourUtc).padStart(2, '0')}:00`;

    this.policy = new dlm.CfnLifecyclePolicy(this, 'Policy', {
      description: props.policyDescription,
      state: 'ENABLED',
      executionRoleArn: role.roleArn,
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: props.volumeTag.key, value: props.volumeTag.value }],
        schedules: [
          {
            name: 'daily',
            // Tags are copied from the volume so a restored snapshot is identifiable, and so the
            // "this holds WhatsApp credentials" marking travels with it.
            copyTags: true,
            tagsToAdd: [
              { key: 'openwa:snapshot', value: 'dlm-daily' },
              { key: 'openwa:sensitive', value: 'whatsapp-auth-state' },
            ],
            createRule: {
              interval: 24,
              intervalUnit: 'HOURS',
              times: [startTime],
            },
            retainRule: { count: props.retentionCount },
          },
        ],
      },
    });
  }
}
