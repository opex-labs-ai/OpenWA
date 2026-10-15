import { Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface OpenwaPrivateAccessProps {
  readonly vpc: ec2.Vpc;
  readonly instance: ec2.Instance;
  readonly peer: {
    readonly vpcId: string;
    readonly cidr: string;
    readonly routeTableIds: readonly string[];
  };
  readonly privateDnsName?: string;
}

/**
 * A private path from one other VPC in the same account and region: a peering connection, a route
 * each way, and optionally a private hosted zone so the caller can use a name instead of an IP.
 *
 * Nothing here is reachable from the internet. The port itself is opened separately, by the
 * backendSecurityGroupId ingress rule, which works across a same-region peering connection.
 */
export class OpenwaPrivateAccess extends Construct {
  public readonly peeringConnectionId: string;

  constructor(scope: Construct, id: string, props: OpenwaPrivateAccessProps) {
    super(scope, id);

    // Same account and region, so CloudFormation accepts the request itself.
    const peering = new ec2.CfnVPCPeeringConnection(this, 'Peering', {
      vpcId: props.vpc.vpcId,
      peerVpcId: props.peer.vpcId,
    });
    this.peeringConnectionId = peering.ref;

    props.vpc.publicSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `ToPeer${index}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: props.peer.cidr,
        vpcPeeringConnectionId: peering.ref,
      });
    });

    // Routes added to route tables this stack does not own. They are removed again on destroy;
    // the route tables themselves are never touched otherwise.
    props.peer.routeTableIds.forEach(routeTableId => {
      new ec2.CfnRoute(this, `FromPeer-${routeTableId}`, {
        routeTableId,
        destinationCidrBlock: props.vpc.vpcCidrBlock,
        vpcPeeringConnectionId: peering.ref,
      });
    });

    if (props.privateDnsName) {
      // L1 so the peer VPC can be associated by id without a context lookup.
      const zone = new route53.CfnHostedZone(this, 'Zone', {
        name: props.privateDnsName,
        hostedZoneConfig: { comment: 'OpenWA private API name. Resolves only inside the associated VPCs.' },
        vpcs: [
          { vpcId: props.vpc.vpcId, vpcRegion: Stack.of(this).region },
          { vpcId: props.peer.vpcId, vpcRegion: Stack.of(this).region },
        ],
      });

      // Tracks the instance: a replacement gets a new private IP and the record follows on deploy.
      new route53.CfnRecordSet(this, 'ApiRecord', {
        hostedZoneId: zone.ref,
        name: props.privateDnsName,
        type: 'A',
        ttl: '60',
        resourceRecords: [props.instance.instancePrivateIp],
      });
    }
  }
}
