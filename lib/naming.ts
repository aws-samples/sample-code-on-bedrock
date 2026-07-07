/**
 * Physical-resource naming helpers for running multiple independent control
 * planes in a single AWS account.
 *
 * Account-global resources (most importantly the `BedrockInvokeAllowed` /
 * `BedrockDenyAll` IAM managed policies) collide if two deployments in the same
 * account use identical physical names. To keep every deployment isolated by
 * default, all named resources are prefixed with a deterministic
 * `CodeOnBedrock-<region>-` prefix derived from the stack's Region.
 *
 * Prefixing is ON by default for every Region. The optional `unprefixedRegions`
 * escape hatch lets specific Regions keep the legacy (unprefixed) names — this
 * exists ONLY to protect a pre-existing deployment that was created before
 * prefixing: renaming a RETAIN DynamoDB table or the Cognito user pool would
 * orphan data / drop users. New deployments should never use it.
 *
 * NOTE: the per-user runtime IAM roles (`BedrockUser-<sub>`) and model policies
 * (`BedrockModels-<sub>-N`) are intentionally NOT prefixed — a Cognito `sub` is
 * a 36-char UUID and `CodeOnBedrock-<region>-BedrockUser-<sub>` exceeds IAM's
 * 64-character role-name limit. They are keyed by `sub` (unique per user pool),
 * so they do not collide between deployments regardless.
 */

/**
 * Resolve the `CodeOnBedrock-<region>-` physical-name prefix for a stack in
 * `region`. Prefixing is on by default; returns `''` only when `region` is in
 * `unprefixedRegions` (a legacy deployment opting out) or is undefined.
 *
 * @param region            the concrete Region the stack deploys to
 * @param unprefixedRegions Region codes that should keep legacy unprefixed
 *                          names (default: none — i.e. always prefix)
 */
export function namePrefixFor(region: string | undefined, unprefixedRegions: string[] = []): string {
  if (!region) return '';
  if (unprefixedRegions.includes(region)) return '';
  return `CodeOnBedrock-${region}-`;
}

/**
 * Build a physical resource name.
 *
 * @param prefix the resolved name prefix (`''` ⇒ use the legacy name verbatim)
 * @param suffix the prefixed-mode name fragment appended after `prefix`
 * @param legacy the exact name to use when `prefix` is empty; defaults to
 *               `suffix` (for resources whose legacy name already equals the
 *               suffix, e.g. the DynamoDB tables)
 */
export function physicalName(prefix: string, suffix: string, legacy?: string): string {
  return prefix ? `${prefix}${suffix}` : (legacy ?? suffix);
}
