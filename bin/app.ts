#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CodeOnBedrockStack } from '../lib/code-on-bedrock-stack';
import { DataStack } from '../lib/data-stack';
import { IdentityStack } from '../lib/identity-stack';
import { ApiStack } from '../lib/api-stack';
import { MeteringStack } from '../lib/metering-stack';
import { ResetStack } from '../lib/reset-stack';
import { CrosscheckStack } from '../lib/crosscheck-stack';
import { RegionalMeteringStack } from '../lib/regional-metering-stack';
import { WebStack } from '../lib/web-stack';
import { resolveRegions, knownRegions, partitionOf, parseRegionListContext } from '../lib/regions';
import { namePrefixFor } from '../lib/naming';

const app = new cdk.App();

// The home Region anchors the single global control plane for this deployment
// (DynamoDB tables, Cognito user pool, the HTTP API + per-user IAM roles, and
// the web UI). There is exactly one per deployment and it cannot be changed
// without standing up a brand-new control plane, so it is a required, explicit
// input rather than a default — deploying to the wrong Region by accident is
// expensive to recover from (RETAIN tables + per-user IAM roles are orphaned).
//
//   cdk deploy --all -c homeRegion=us-east-1
//
// or persist it under "context" in cdk.json.
const homeRegion = app.node.tryGetContext('homeRegion') as string | undefined;
if (!homeRegion) {
  throw new Error(
    'homeRegion is required. Pass it via CDK context, e.g.\n' +
      '  cdk deploy --all -c homeRegion=us-east-1\n' +
      'or set "homeRegion" under "context" in cdk.json.',
  );
}

// additionalRegions is validated against the home Region's partition, so the
// home Region must itself resolve to a known partition.
// (knownRegions(undefined) would otherwise silently span every partition.)
const homePartition = partitionOf(homeRegion);
if (!homePartition) {
  throw new Error(
    `homeRegion "${homeRegion}" is not a known AWS Region in the CDK region ` +
      'database, so its partition cannot be resolved for Region scoping. ' +
      'Check the Region code, or upgrade aws-cdk-lib if this is a brand-new Region.',
  );
}

const homeEnv = { env: { region: homeRegion, account: process.env.CDK_DEFAULT_ACCOUNT } };

// Single source of truth for the Regions developers may call Bedrock from.
//
// Bedrock writes each invocation's log + metrics in the **source** Region (the
// Region whose endpoint the client calls), even when a geographic cross-Region
// inference profile routes the actual inference to a different destination
// Region. So metering only needs to run where developers call from, and access
// must be pinned to those same Regions. `additionalRegions` is an optional,
// explicit list of extra source Regions (concrete codes only, e.g.
// "eu-west-1"; no wildcards). It defaults to [] and each entry is validated
// against the home Region's partition, so a typo or a Region outside that
// partition fails fast at synth time rather than silently expanding.
//
// This list drives BOTH the metering stacks (below) and the ApiStack's Region
// restriction, so the two can't drift: every source Region has a metering
// stack (home → MeteringStack, each additional → MeteringStack-<region>).
const additionalRegionsContext = parseRegionListContext(app.node.tryGetContext('additionalRegions'));
const partitionRegions = knownRegions(homePartition);
const additionalRegions = resolveRegions(additionalRegionsContext, {
  exclude: homeRegion,
  available: partitionRegions,
});
const sourceRegions = [homeRegion, ...additionalRegions];

// Physical-name prefixing (CodeOnBedrock-<region>-) is ON by default for every
// Region, so every deployment is isolated and a second control plane can live
// in another Region of the same account without colliding on the account-global
// IAM managed policies (BedrockInvokeAllowed / BedrockDenyAll).
//
// `unprefixedRegions` is an optional escape hatch (default []) listing Regions
// that must keep the legacy unprefixed names. It exists ONLY to protect a
// pre-existing deployment created before prefixing — renaming its RETAIN tables
// or Cognito user pool would orphan data / drop users. New deployments should
// never set it. Persist it in cdk.json so the same context is passed on every
// `cdk` invocation regardless of which Region you deploy.
const unprefixedRegions = parseRegionListContext(app.node.tryGetContext('unprefixedRegions'));
const homeNamePrefix = namePrefixFor(homeRegion, unprefixedRegions);

// Optional verified SES sender for the per-user budget-warning emails. When
// omitted, the metering stacks fall back to DEFAULT_SES_FROM_ADDRESS (a
// placeholder that won't deliver until replaced). scripts/deploy.sh prompts for
// this and passes it as `-c sesFromAddress=...`.
const sesFromAddress = app.node.tryGetContext('sesFromAddress') as string | undefined;

new CodeOnBedrockStack(app, 'CodeOnBedrockStack', homeEnv);
const data = new DataStack(app, 'DataStack', { ...homeEnv, namePrefix: homeNamePrefix });

// WebStack is created before IdentityStack so its CloudFront URL can be wired
// into the Cognito app client's callback/logout URLs. Without this, the Hosted
// UI rejects the web UI's `redirect_uri` (`<cloudfront-origin>/`) with a
// redirect mismatch. WebStack is otherwise standalone (S3 + CloudFront), so it
// has no dependency back on IdentityStack/ApiStack — no cycle.
const web = new WebStack(app, 'WebStack', { ...homeEnv, namePrefix: homeNamePrefix });

const identity = new IdentityStack(app, 'IdentityStack', {
  ...homeEnv,
  namePrefix: homeNamePrefix,
  // The web app uses `${origin}/` as both login redirect_uri and logout_uri
  // (web/lib/auth-context.tsx). IdentityStack appends this to the client's
  // allowed callback + logout URLs.
  webCallbackUrl: `https://${web.distribution.distributionDomainName}`,
});
const api = new ApiStack(app, 'ApiStack', {
  ...homeEnv,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  userLimitsTable: data.userLimitsTable,
  usageCountersTable: data.usageCountersTable,
  usersTable: data.usersTable,
  tiersTable: data.tiersTable,
  modelRatesTable: data.modelRatesTable,
  sourceRegions,
  namePrefix: homeNamePrefix,
});
new MeteringStack(app, 'MeteringStack', {
  ...homeEnv,
  usageCountersTable: data.usageCountersTable,
  modelRatesTable: data.modelRatesTable,
  userLimitsTable: data.userLimitsTable,
  usersTable: data.usersTable,
  killSwitchFunction: api.killSwitchFunction,
  warningTopic: api.warningTopic,
  sesFromAddress,
  namePrefix: homeNamePrefix,
});
new ResetStack(app, 'ResetStack', {
  ...homeEnv,
  userLimitsTable: data.userLimitsTable,
  usageCountersTable: data.usageCountersTable,
  bedrockDenyPolicyArn: api.bedrockDenyPolicyArn,
});
new CrosscheckStack(app, 'CrosscheckStack', {
  ...homeEnv,
  usersTable: data.usersTable,
  usageCountersTable: data.usageCountersTable,
});

// R-MR-2: Regional metering stacks — one per additional source Region. The
// home Region always has the primary `MeteringStack` (above); each additional
// source Region gets its own `MeteringStack-<region>`. `additionalRegions` and
// the ApiStack's `sourceRegions` are resolved together above, so they stay in
// lockstep.
for (const region of additionalRegions) {
  new RegionalMeteringStack(app, `MeteringStack-${region}`, {
    env: { region, account: process.env.CDK_DEFAULT_ACCOUNT },
    homeRegion,
    namePrefix: namePrefixFor(region, unprefixedRegions),
    usageCountersTableName: data.usageCountersTable.tableName,
    usageCountersTableArn: data.usageCountersTable.tableArn,
    modelRatesTableName: data.modelRatesTable.tableName,
    modelRatesTableArn: data.modelRatesTable.tableArn,
    userLimitsTableName: data.userLimitsTable.tableName,
    userLimitsTableArn: data.userLimitsTable.tableArn,
    usersTableName: data.usersTable.tableName,
    usersTableArn: data.usersTable.tableArn,
    killSwitchFunctionArn: api.killSwitchFunction.functionArn,
    warningTopicArn: api.warningTopic.topicArn,
    sesFromAddress,
  });
}

// WebStack is instantiated earlier (before IdentityStack) so its CloudFront URL
// can be wired into the Cognito callback/logout URLs.
