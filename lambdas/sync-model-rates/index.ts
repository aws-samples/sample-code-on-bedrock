import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';

export interface SyncDeps {
  ddb: DynamoDBClient;
  pricing: PricingClient;
  bedrock: BedrockClient;
}

interface PriceEntry { modelId: string; modelName: string; inputPer1k: number; outputPer1k: number }

export async function syncModelRates(tableName: string, region: string, deps: SyncDeps) {
  // 1. Get available models and inference profiles
  const modelsResp = await deps.bedrock.send(new ListFoundationModelsCommand({}));
  const profilesResp = await deps.bedrock.send(new ListInferenceProfilesCommand({}));
  const models = modelsResp.modelSummaries ?? [];
  const profiles = profilesResp.inferenceProfileSummaries ?? [];

  // Build modelName→modelId map
  const nameToId = new Map<string, string>();
  for (const m of models) {
    if (m.modelName && m.modelId) nameToId.set(m.modelName, m.modelId);
  }

  // Build modelId→inference profile IDs map
  const modelToProfiles = new Map<string, string[]>();
  for (const p of profiles) {
    const underlying = p.models?.[0]?.modelArn?.split('/').pop();
    if (!underlying || !p.inferenceProfileId) continue;
    const list = modelToProfiles.get(underlying) ?? [];
    list.push(p.inferenceProfileId);
    modelToProfiles.set(underlying, list);
  }

  // 2. Fetch on-demand prices (AmazonBedrock service code, per 1K tokens)
  const inputPrices = await fetchOnDemandPrices(deps.pricing, region, 'Input tokens');
  const outputPrices = await fetchOnDemandPrices(deps.pricing, region, 'Output tokens');

  // 3. Fetch Marketplace prices (AmazonBedrockFoundationModels, per Million tokens)
  const mpPrices = await fetchMarketplacePrices(deps.pricing, region);

  // 4. Build normalized lookups for fuzzy matching
  const normInput = new Map<string, number>();
  for (const [name, price] of inputPrices) normInput.set(normalize(name), price);
  const normOutput = new Map<string, number>();
  for (const [name, price] of outputPrices) normOutput.set(normalize(name), price);

  // 5. Match models to prices
  const results: PriceEntry[] = [];
  const seen = new Set<string>();

  for (const [modelName, modelId] of nameToId) {
    let inp = inputPrices.get(modelName) ?? normInput.get(normalize(modelName));
    let out = outputPrices.get(modelName) ?? normOutput.get(normalize(modelName));

    // Fallback: check if any pricing key is a prefix of the normalized model name
    if (inp === undefined || out === undefined) {
      const norm = normalize(modelName);
      for (const [priceName, price] of normInput) {
        if (norm.startsWith(priceName + ' ') || priceName.startsWith(norm + ' ')) {
          if (inp === undefined) inp = price;
          const outPrice = normOutput.get(priceName);
          if (out === undefined && outPrice !== undefined) out = outPrice;
          break;
        }
      }
    }

    if (inp === undefined || out === undefined) {
      const mp = mpPrices.get(modelName) ?? mpPrices.get(normalize(modelName));
      if (mp) {
        inp = inp ?? mp.input / 1000;
        out = out ?? mp.output / 1000;
      }
    }

    if (inp === undefined || out === undefined) continue;

    results.push({ modelId, modelName, inputPer1k: inp, outputPer1k: out });
    seen.add(modelId);

    for (const profileId of modelToProfiles.get(modelId) ?? []) {
      if (!seen.has(profileId)) {
        results.push({ modelId: profileId, modelName, inputPer1k: inp, outputPer1k: out });
        seen.add(profileId);
      }
    }
  }

  // 6. Write all matched rates to DynamoDB
  await Promise.all(results.map(r => writeRate(deps.ddb, tableName, r.modelId, r.modelName, r.inputPer1k, r.outputPer1k)));

  console.log(`Synced ${results.length} model rates for region ${region}`);
  return results;
}

async function writeRate(ddb: DynamoDBClient, table: string, modelId: string, displayName: string, inp: number, out: number) {
  await ddb.send(new PutItemCommand({
    TableName: table,
    Item: {
      modelId: { S: modelId },
      SK: { S: '-' },
      inputUsdPer1k: { N: String(inp) },
      outputUsdPer1k: { N: String(out) },
      displayName: { S: displayName },
      source: { S: 'pricing-api' },
      updatedAt: { S: new Date().toISOString() },
    },
  }));
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, '')       // strip ALL parentheticals
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\binstruct\b/g, '')
    .replace(/\b(\d+)\s*\.?\s*0\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// On-demand pricing from AmazonBedrock (returns USD per 1K tokens)
async function fetchOnDemandPrices(pricing: PricingClient, region: string, inferenceType: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  let nextToken: string | undefined;
  do {
    const resp = await pricing.send(new GetProductsCommand({
      ServiceCode: 'AmazonBedrock',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
        { Type: 'TERM_MATCH', Field: 'inferenceType', Value: inferenceType },
      ],
      NextToken: nextToken,
    }));
    for (const raw of resp.PriceList ?? []) {
      const product = JSON.parse(String(raw));
      const modelName: string | undefined = product.product?.attributes?.model;
      if (!modelName) continue;
      const usd = extractPrice(product);
      if (usd !== undefined && !prices.has(modelName)) prices.set(modelName, usd);
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return prices;
}

// Marketplace pricing from AmazonBedrockFoundationModels (returns USD per Million tokens)
async function fetchMarketplacePrices(pricing: PricingClient, region: string): Promise<Map<string, { input: number; output: number }>> {
  const prices = new Map<string, { input: number; output: number }>();
  let nextToken: string | undefined;
  do {
    const resp = await pricing.send(new GetProductsCommand({
      ServiceCode: 'AmazonBedrockFoundationModels',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
      ],
      NextToken: nextToken,
    }));
    for (const raw of resp.PriceList ?? []) {
      const product = JSON.parse(String(raw));
      const attrs = product.product?.attributes ?? {};
      const serviceName: string = attrs.servicename ?? '';
      const usagetype: string = attrs.usagetype ?? '';

      // Skip reserved, batch, cache, provisioned
      if (/Reserved|Batch|[Cc]ache|Provisioned/i.test(usagetype)) continue;
      // Only regional standard token counts (not _Global which is cross-region)
      if (/_Global/i.test(usagetype)) continue;

      const isInput = /InputTokenCount|input_tokens_standard/i.test(usagetype) && !/Output/i.test(usagetype);
      const isOutput = /OutputTokenCount|output_tokens_standard/i.test(usagetype) && !/Input/i.test(usagetype);
      if (!isInput && !isOutput) continue;

      const usd = extractPrice(product);
      if (usd === undefined) continue;

      // Strip " (Amazon Bedrock Edition)" from service name to get model name
      const modelName = serviceName.replace(/\s*\(Amazon Bedrock Edition\)\s*$/, '');
      if (!modelName) continue;

      const existing = prices.get(modelName) ?? { input: 0, output: 0 };
      if (isInput && !existing.input) existing.input = usd;
      if (isOutput && !existing.output) existing.output = usd;
      prices.set(modelName, existing);
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  // Also store normalized keys for fuzzy matching
  const result = new Map<string, { input: number; output: number }>();
  for (const [name, val] of prices) {
    if (val.input && val.output) {
      result.set(name, val);
      result.set(normalize(name), val);
    }
  }
  return result;
}

function extractPrice(product: any): number | undefined {
  const terms = product.terms?.OnDemand;
  if (!terms) return undefined;
  for (const term of Object.values(terms) as any[]) {
    for (const dim of Object.values(term.priceDimensions ?? {}) as any[]) {
      const usd = parseFloat(dim.pricePerUnit?.USD);
      if (!isNaN(usd)) return usd;
    }
  }
  return undefined;
}

const ddb = new DynamoDBClient({});
const pricing = new PricingClient({ region: 'us-east-1' });
let bedrock: BedrockClient;

export const handler = async () => {
  const region = process.env.AWS_REGION ?? process.env.BEDROCK_REGION!;
  if (!bedrock) bedrock = new BedrockClient({ region });
  const results = await syncModelRates(
    process.env.MODEL_RATES_TABLE!,
    region,
    { ddb, pricing, bedrock },
  );
  return { statusCode: 200, body: JSON.stringify({ synced: results.length, rates: results }) };
};
