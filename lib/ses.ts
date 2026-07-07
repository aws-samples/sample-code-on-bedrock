/**
 * Default SES sender identity for the per-user budget-warning emails sent by
 * the metering Lambda. This is a placeholder address — to actually deliver
 * mail it must be replaced (via the `sesFromAddress` CDK context, surfaced as a
 * prompt in scripts/deploy.sh) with an identity verified in SES for the
 * deployment account/Region. In the SES sandbox both this sender and every
 * recipient must be verified.
 *
 * Shared by MeteringStack and RegionalMeteringStack so the default never drifts
 * between the home Region and additional source Regions.
 */
export const DEFAULT_SES_FROM_ADDRESS = 'no-reply@amazonses.com';
