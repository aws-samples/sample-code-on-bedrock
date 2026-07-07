import { RegionInfo } from 'aws-cdk-lib/region-info';

/**
 * Normalize a raw `additionalRegions` CDK context value into a string array.
 *
 * The value can arrive in different shapes depending on how it was supplied:
 *  - from `cdk.json` `"context"` it is already a real array;
 *  - from the CLI (`-c additionalRegions=...`) it is always a raw string, so a
 *    JSON-array literal (`'["eu-west-1","eu-west-3"]'`) or a comma-separated
 *    list (`eu-west-1,eu-west-3`) or a single code (`eu-west-1`) are all
 *    accepted;
 *  - `undefined`/empty means "not set" and yields `[]`.
 *
 * @throws if the value is a non-empty string that starts like JSON but isn't a
 *   valid JSON array of strings, or is some other non-array/non-string type.
 */
export function parseRegionListContext(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(
          `additionalRegions: "${raw}" is not valid JSON; pass a JSON array ` +
            `like '["eu-west-1","eu-west-3"]' or a comma-separated list.`,
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error('additionalRegions: JSON value must be an array of region codes');
      }
      return parsed.map(String);
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  throw new Error('additionalRegions: must be an array or string of region codes');
}

/**
 * All AWS region codes known to the CDK `region-info` fact database
 * (e.g. `eu-central-1`, `us-east-1`, ...), sorted alphabetically.
 *
 * This is resolved at synth time from data bundled with `aws-cdk-lib`, so it
 * requires no AWS credentials or network access and keeps `cdk synth`
 * deterministic. The list tracks the AWS partitions/regions known to the
 * installed CDK version, so deploying to a brand-new region not yet in the
 * fact database requires upgrading `aws-cdk-lib`.
 *
 * @param partition Optional partition filter (e.g. `aws`, `aws-cn`,
 *   `aws-us-gov`, `aws-iso-e`). When provided, only regions in that partition
 *   are returned — useful to scope additionalRegions validation to the home
 *   region's partition and reject isolated/GovCloud regions that share a geo
 *   prefix with commercial ones (e.g. `eu-isoe-west-1` vs `eu-west-1`).
 */
export function knownRegions(partition?: string): string[] {
  return RegionInfo.regions
    .filter((r) => partition === undefined || r.partition === partition)
    .map((r) => r.name)
    .sort();
}

/**
 * The partition a region belongs to (e.g. `aws`, `aws-cn`, `aws-us-gov`,
 * `aws-iso-e`), or `undefined` if the region is not in the CDK region
 * database.
 */
export function partitionOf(region: string): string | undefined {
  return RegionInfo.get(region).partition;
}

export interface ResolveRegionsOptions {
  /** Region to always exclude from the result (typically the home region). */
  exclude?: string;
  /**
   * The universe of valid region codes each entry must be a member of.
   * Defaults to {@link knownRegions}. Injectable for deterministic testing.
   */
  available?: string[];
}

/**
 * Validate an explicit list of concrete AWS region codes.
 *
 * Every entry MUST be a literal region code that exists in `available` (the
 * home region's partition, by default) — there is no wildcard/glob expansion,
 * so the result never contains a region that wasn't explicitly listed. Entries
 * are de-duplicated, the `exclude` region is removed, and the list is returned
 * sorted for stable synth output.
 *
 * @throws if an entry is not a known region in `available` (a typo or a region
 *   outside the home partition), so misconfiguration fails fast at synth time.
 */
export function resolveRegions(regions: string[], options: ResolveRegionsOptions = {}): string[] {
  const available = options.available ?? knownRegions();
  const availableSet = new Set(available);
  const resolved = new Set<string>();

  for (const region of regions) {
    if (!availableSet.has(region)) {
      throw new Error(
        `additionalRegions: "${region}" is not a known AWS region in the home partition`,
      );
    }
    resolved.add(region);
  }

  if (options.exclude) resolved.delete(options.exclude);
  return [...resolved].sort();
}
