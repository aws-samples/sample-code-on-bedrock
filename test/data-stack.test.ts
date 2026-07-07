import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new DataStack(app, 'TestDataStack');
  template = Template.fromStack(stack);
});

// R-DM-1: All tables use on-demand capacity
describe('billing mode', () => {
  test('all tables use PAY_PER_REQUEST', () => {
    const tables = template.findResources('AWS::DynamoDB::GlobalTable');
    const tableNames = Object.keys(tables);
    expect(tableNames.length).toBe(5);
    for (const name of tableNames) {
      expect(tables[name].Properties.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });
});

// R-DM-2: Table key schemas
describe('key schemas', () => {
  test('Users table has PK (S) and SK (S)', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'Users',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    });
  });

  test('UserLimits table has PK (S) and SK (S)', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'UserLimits',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    });
  });

  test('UsageCounters table has PK (S) and SK (S)', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'UsageCounters',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  test('ModelRates table has modelId (S) and SK (S)', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'ModelRates',
      KeySchema: [
        { AttributeName: 'modelId', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'modelId', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    });
  });
});

// R-DM-3: byPeriod GSI on UsageCounters
describe('byPeriod GSI', () => {
  test('UsageCounters has byPeriod GSI with PK=SK, SK=PK, ProjectionType=ALL', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'UsageCounters',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'byPeriod',
          KeySchema: [
            { AttributeName: 'SK', KeyType: 'HASH' },
            { AttributeName: 'PK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });
});

// Removal policy
describe('removal policy', () => {
  test('all tables have DeletionPolicy Retain', () => {
    const tables = template.findResources('AWS::DynamoDB::GlobalTable');
    for (const name of Object.keys(tables)) {
      expect(tables[name].DeletionPolicy).toBe('Retain');
    }
  });
});

// CfnOutputs for cross-stack references
describe('exports', () => {
  test('exports table names and ARNs', () => {
    template.hasOutput('UsersTableName', {});
    template.hasOutput('UsersTableArn', {});
    template.hasOutput('UserLimitsTableName', {});
    template.hasOutput('UserLimitsTableArn', {});
    template.hasOutput('UsageCountersTableName', {});
    template.hasOutput('UsageCountersTableArn', {});
    template.hasOutput('ModelRatesTableName', {});
    template.hasOutput('ModelRatesTableArn', {});
  });
});
