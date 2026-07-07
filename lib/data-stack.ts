import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { physicalName } from './naming';

export interface DataStackProps extends cdk.StackProps {
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ legacy table names. See
   * lib/naming.ts.
   */
  namePrefix?: string;
}

export class DataStack extends cdk.Stack {
  public readonly usersTable: dynamodb.TableV2;
  public readonly userLimitsTable: dynamodb.TableV2;
  public readonly usageCountersTable: dynamodb.TableV2;
  public readonly modelRatesTable: dynamodb.TableV2;
  public readonly tiersTable: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props?: DataStackProps) {
    super(scope, id, props);

    const prefix = props?.namePrefix ?? '';
    const strKey = (name: string) => ({ name, type: dynamodb.AttributeType.STRING });

    const users = new dynamodb.TableV2(this, 'UsersTable', {
      tableName: physicalName(prefix, 'Users'),
      partitionKey: strKey('PK'),
      sortKey: strKey('SK'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.usersTable = users;

    const userLimits = new dynamodb.TableV2(this, 'UserLimitsTable', {
      tableName: physicalName(prefix, 'UserLimits'),
      partitionKey: strKey('PK'),
      sortKey: strKey('SK'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.userLimitsTable = userLimits;

    const usageCounters = new dynamodb.TableV2(this, 'UsageCountersTable', {
      tableName: physicalName(prefix, 'UsageCounters'),
      partitionKey: strKey('PK'),
      sortKey: strKey('SK'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'byPeriod',
          partitionKey: strKey('SK'),
          sortKey: strKey('PK'),
        },
      ],
    });
    this.usageCountersTable = usageCounters;

    const modelRates = new dynamodb.TableV2(this, 'ModelRatesTable', {
      tableName: physicalName(prefix, 'ModelRates'),
      partitionKey: strKey('modelId'),
      sortKey: strKey('SK'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.modelRatesTable = modelRates;

    const tiers = new dynamodb.TableV2(this, 'TiersTable', {
      tableName: physicalName(prefix, 'Tiers'),
      partitionKey: strKey('tierId'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.tiersTable = tiers;

    // Cross-stack exports
    const tables = { Users: users, UserLimits: userLimits, UsageCounters: usageCounters, ModelRates: modelRates, Tiers: tiers };
    for (const [name, table] of Object.entries(tables)) {
      new cdk.CfnOutput(this, `${name}TableName`, { value: table.tableName });
      new cdk.CfnOutput(this, `${name}TableArn`, { value: table.tableArn });
    }
  }
}
