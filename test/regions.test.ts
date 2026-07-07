import { resolveRegions, knownRegions, partitionOf, parseRegionListContext } from '../lib/regions';

// A deterministic region universe for validation assertions.
const AVAILABLE = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-3',
  'eu-north-1',
  'ap-southeast-1',
  'ap-southeast-2',
];

describe('resolveRegions', () => {
  test('passes through an explicit list of concrete region codes, sorted', () => {
    expect(resolveRegions(['eu-west-3', 'eu-west-1', 'us-east-1'], { available: AVAILABLE })).toEqual([
      'eu-west-1',
      'eu-west-3',
      'us-east-1',
    ]);
  });

  test('de-duplicates repeated entries', () => {
    expect(resolveRegions(['eu-west-1', 'eu-west-1', 'us-east-1'], { available: AVAILABLE })).toEqual([
      'eu-west-1',
      'us-east-1',
    ]);
  });

  test('excludes the home region from results', () => {
    expect(
      resolveRegions(['eu-central-1', 'eu-west-1'], { available: AVAILABLE, exclude: 'eu-central-1' }),
    ).toEqual(['eu-west-1']);
  });

  test('returns an empty list for empty input', () => {
    expect(resolveRegions([], { available: AVAILABLE })).toEqual([]);
  });

  test('throws on an unknown region code (typo) rather than expanding', () => {
    expect(() => resolveRegions(['eu-west-9'], { available: AVAILABLE })).toThrow(
      /is not a known AWS region in the home partition/,
    );
  });

  test('throws on a region outside the available (home-partition) set', () => {
    expect(() => resolveRegions(['ca-central-1'], { available: AVAILABLE })).toThrow(
      /"ca-central-1" is not a known AWS region/,
    );
  });

  test('does not treat "*" as a wildcard — an unknown literal throws', () => {
    expect(() => resolveRegions(['*'], { available: AVAILABLE })).toThrow(
      /is not a known AWS region/,
    );
  });
});

describe('parseRegionListContext', () => {
  test('returns [] for undefined/null/empty', () => {
    expect(parseRegionListContext(undefined)).toEqual([]);
    expect(parseRegionListContext(null)).toEqual([]);
    expect(parseRegionListContext('')).toEqual([]);
    expect(parseRegionListContext('   ')).toEqual([]);
  });

  test('passes through a real array (cdk.json form)', () => {
    expect(parseRegionListContext(['eu-west-1', 'eu-west-3'])).toEqual(['eu-west-1', 'eu-west-3']);
  });

  test('parses a JSON-array string (-c CLI form)', () => {
    expect(parseRegionListContext('["eu-west-1","eu-west-3"]')).toEqual(['eu-west-1', 'eu-west-3']);
  });

  test('parses a comma-separated string', () => {
    expect(parseRegionListContext('eu-west-1, eu-west-3')).toEqual(['eu-west-1', 'eu-west-3']);
  });

  test('parses a single bare region code', () => {
    expect(parseRegionListContext('eu-west-1')).toEqual(['eu-west-1']);
  });

  test('throws on a malformed JSON-array string', () => {
    expect(() => parseRegionListContext('["eu-west-1"')).toThrow(/is not valid JSON/);
  });

  test('treats a non-bracketed string as a single entry (validated downstream)', () => {
    expect(parseRegionListContext('{"a":1}')).toEqual(['{"a":1}']);
  });
});

describe('knownRegions', () => {
  test('returns a non-empty, sorted list including common regions', () => {
    const regions = knownRegions();
    expect(regions.length).toBeGreaterThan(0);
    expect(regions).toContain('eu-central-1');
    expect(regions).toContain('us-east-1');
    expect([...regions]).toEqual([...regions].sort());
  });
});

describe('partitionOf', () => {
  test('reports the partition for known regions', () => {
    expect(partitionOf('eu-central-1')).toBe('aws');
    expect(partitionOf('eu-isoe-west-1')).toBe('aws-iso-e');
  });

  test('returns undefined for unknown regions', () => {
    expect(partitionOf('xx-new-1')).toBeUndefined();
  });
});

describe('knownRegions partition filter', () => {
  test('aws partition excludes isolated/GovCloud regions that share a geo prefix', () => {
    const commercial = knownRegions('aws');
    expect(commercial).toContain('eu-west-1');
    expect(commercial).not.toContain('eu-isoe-west-1');
    expect(commercial.some((r) => r.startsWith('us-gov-'))).toBe(false);
    expect(commercial.some((r) => r.includes('-iso'))).toBe(false);
  });
});
