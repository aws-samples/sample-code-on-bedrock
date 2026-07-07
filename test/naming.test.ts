import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { IdentityStack } from '../lib/identity-stack';
import { ApiStack } from '../lib/api-stack';
import { MeteringStack } from '../lib/metering-stack';
import { RegionalMeteringStack } from '../lib/regional-metering-stack';
import { namePrefixFor, physicalName } from '../lib/naming';

const PREFIX = 'CodeOnBedrock-us-east-1-';

// ── Pure helper unit tests ──────────────────────────────────────────────────

describe('namePrefixFor', () => {
  test('returns CodeOnBedrock-<region>- by default (always prefix)', () => {
    expect(namePrefixFor('us-east-1')).toBe('CodeOnBedrock-us-east-1-');
    expect(namePrefixFor('eu-central-1', [])).toBe('CodeOnBedrock-eu-central-1-');
  });

  test('returns empty string only when the region opts out via unprefixedRegions', () => {
    expect(namePrefixFor('eu-central-1', ['eu-central-1'])).toBe('');
  });

  test('still prefixes regions not in the unprefixedRegions list', () => {
    expect(namePrefixFor('us-east-1', ['eu-central-1'])).toBe('CodeOnBedrock-us-east-1-');
  });

  test('returns empty string when region is undefined', () => {
    expect(namePrefixFor(undefined, [])).toBe('');
  });
});

describe('physicalName', () => {
  test('prepends the prefix to the suffix when prefix is set', () => {
    expect(physicalName(PREFIX, 'BedrockDenyAll')).toBe('CodeOnBedrock-us-east-1-BedrockDenyAll');
  });

  test('uses the suffix verbatim when prefix is empty and no legacy given', () => {
    expect(physicalName('', 'Users')).toBe('Users');
  });

  test('uses the legacy name when prefix is empty and legacy differs from suffix', () => {
    expect(physicalName('', 'KillSwitch', 'CodeOnBedrock-KillSwitch')).toBe('CodeOnBedrock-KillSwitch');
  });

  test('uses prefix+suffix (not legacy) when prefix is set', () => {
    expect(physicalName(PREFIX, 'KillSwitch', 'CodeOnBedrock-KillSwitch')).toBe(
      'CodeOnBedrock-us-east-1-KillSwitch',
    );
  });
});

// ── Helpers to synth stacks with/without a prefix ───────────────────────────

function buildApiTemplates(namePrefix: string) {
  const app = new cdk.App();
  const data = new DataStack(app, 'D', { namePrefix });
  const identity = new IdentityStack(app, 'I', { namePrefix });
  const api = new ApiStack(app, 'A', {
    userPool: identity.userPool,
    userPoolClient: identity.userPoolClient,
    userLimitsTable: data.userLimitsTable,
    usageCountersTable: data.usageCountersTable,
    usersTable: data.usersTable,
    tiersTable: data.tiersTable,
    modelRatesTable: data.modelRatesTable,
    sourceRegions: ['us-east-1'],
    namePrefix,
  });
  const metering = new MeteringStack(app, 'M', {
    usageCountersTable: data.usageCountersTable,
    modelRatesTable: data.modelRatesTable,
    userLimitsTable: data.userLimitsTable,
    usersTable: data.usersTable,
    killSwitchFunction: api.killSwitchFunction,
    warningTopic: api.warningTopic,
    namePrefix,
  });
  return {
    data: Template.fromStack(data),
    identity: Template.fromStack(identity),
    api: Template.fromStack(api),
    metering: Template.fromStack(metering),
  };
}

// ── Prefixed deployment ─────────────────────────────────────────────────────

describe('with CodeOnBedrock-<region>- prefix', () => {
  let t: ReturnType<typeof buildApiTemplates>;
  beforeAll(() => {
    t = buildApiTemplates(PREFIX);
  });

  test('DynamoDB tables are prefixed', () => {
    for (const name of ['Users', 'UserLimits', 'UsageCounters', 'ModelRates', 'Tiers']) {
      t.data.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: `${PREFIX}${name}`,
      });
    }
  });

  test('Cognito user pool name is prefixed', () => {
    t.identity.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: `${PREFIX}UserPool`,
    });
  });

  test('admin group name is NOT prefixed (authz depends on it)', () => {
    t.identity.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'admin',
    });
  });

  test('the account-global managed policies are prefixed', () => {
    t.api.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: `${PREFIX}BedrockInvokeAllowed`,
    });
    t.api.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: `${PREFIX}BedrockDenyAll`,
    });
  });

  test('KillSwitch function name is prefixed', () => {
    t.api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `${PREFIX}KillSwitch`,
    });
  });

  test('warning SNS topic name is prefixed', () => {
    t.api.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `${PREFIX}DailyBudgetWarning`,
    });
  });

  test('metering log group name is prefixed', () => {
    t.metering.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `${PREFIX}bedrock-invocation-logs`,
    });
  });

  test('regional metering log group name is prefixed', () => {
    const app = new cdk.App();
    const regional = new RegionalMeteringStack(app, 'RM', {
      env: { region: 'us-east-1', account: '111111111111' },
      homeRegion: 'eu-central-1',
      namePrefix: PREFIX,
      usageCountersTableName: 'UsageCounters',
      usageCountersTableArn: 'arn:aws:dynamodb:eu-central-1:111111111111:table/UsageCounters',
      modelRatesTableName: 'ModelRates',
      modelRatesTableArn: 'arn:aws:dynamodb:eu-central-1:111111111111:table/ModelRates',
      userLimitsTableName: 'UserLimits',
      userLimitsTableArn: 'arn:aws:dynamodb:eu-central-1:111111111111:table/UserLimits',
      usersTableName: 'Users',
      usersTableArn: 'arn:aws:dynamodb:eu-central-1:111111111111:table/Users',
      killSwitchFunctionArn: 'arn:aws:lambda:eu-central-1:111111111111:function:CodeOnBedrock-KillSwitch',
      warningTopicArn: 'arn:aws:sns:eu-central-1:111111111111:DailyBudgetWarning',
    });
    Template.fromStack(regional).hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `${PREFIX}bedrock-invocation-logs`,
    });
  });
});

// ── Default (no prefix) preserves exact legacy names ────────────────────────

describe('without a prefix (default)', () => {
  let t: ReturnType<typeof buildApiTemplates>;
  beforeAll(() => {
    t = buildApiTemplates('');
  });

  test('DynamoDB tables keep legacy names', () => {
    for (const name of ['Users', 'UserLimits', 'UsageCounters', 'ModelRates', 'Tiers']) {
      t.data.hasResourceProperties('AWS::DynamoDB::GlobalTable', { TableName: name });
    }
  });

  test('Cognito user pool keeps legacy name', () => {
    t.identity.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'CodeOnBedrockUserPool',
    });
  });

  test('managed policies keep legacy names', () => {
    t.api.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockInvokeAllowed',
    });
    t.api.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockDenyAll',
    });
  });

  test('KillSwitch keeps legacy CodeOnBedrock-KillSwitch name', () => {
    t.api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'CodeOnBedrock-KillSwitch',
    });
  });

  test('warning topic keeps legacy name', () => {
    t.api.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'DailyBudgetWarning',
    });
  });

  test('metering log group keeps legacy /aws/bedrock/invocation-logs name', () => {
    t.metering.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/bedrock/invocation-logs',
    });
  });
});
