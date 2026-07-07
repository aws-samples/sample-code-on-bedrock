import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

export interface ModelRatesDeps {
  ddb: DynamoDBClient;
}

export async function processModelRates(routeKey: string, tableName: string, pathParams: { modelId?: string }, body: string | undefined, deps: ModelRatesDeps) {
  if (routeKey === 'GET /admin/model-rates') {
    const result = await deps.ddb.send(new ScanCommand({ TableName: tableName }));
    const rates = (result.Items ?? []).map((item) => ({
      modelId: item.modelId?.S,
      inputUsdPer1k: Number(item.inputUsdPer1k?.N ?? 0),
      outputUsdPer1k: Number(item.outputUsdPer1k?.N ?? 0),
      displayName: item.displayName?.S ?? undefined,
    }));
    return { statusCode: 200, body: JSON.stringify({ rates }) };
  }

  if (routeKey === 'POST /admin/model-rates') {
    const { modelId, inputUsdPer1k, outputUsdPer1k, displayName } = JSON.parse(body!);
    if (!modelId || inputUsdPer1k === undefined || outputUsdPer1k === undefined) {
      return { statusCode: 400, body: JSON.stringify({ message: 'modelId, inputUsdPer1k, and outputUsdPer1k are required' }) };
    }
    const item: Record<string, { S: string } | { N: string }> = {
      modelId: { S: modelId },
      SK: { S: '-' },
      inputUsdPer1k: { N: String(inputUsdPer1k) },
      outputUsdPer1k: { N: String(outputUsdPer1k) },
    };
    if (displayName) item.displayName = { S: displayName };
    await deps.ddb.send(new PutItemCommand({ TableName: tableName, Item: item }));
    return { statusCode: 201, body: JSON.stringify({ message: 'Model rate created', modelId }) };
  }

  if (routeKey === 'PUT /admin/model-rates/{modelId}') {
    const modelId = decodeURIComponent(pathParams.modelId!);
    const parsed = JSON.parse(body!);
    const parts: string[] = [];
    const values: Record<string, { N: string } | { S: string }> = {};
    if (parsed.inputUsdPer1k !== undefined) { parts.push('inputUsdPer1k = :i'); values[':i'] = { N: String(parsed.inputUsdPer1k) }; }
    if (parsed.outputUsdPer1k !== undefined) { parts.push('outputUsdPer1k = :o'); values[':o'] = { N: String(parsed.outputUsdPer1k) }; }
    if (parsed.displayName !== undefined) { parts.push('displayName = :d'); values[':d'] = { S: parsed.displayName }; }
    if (parts.length === 0) return { statusCode: 400, body: JSON.stringify({ message: 'No fields to update' }) };
    await deps.ddb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { modelId: { S: modelId }, SK: { S: '-' } },
      UpdateExpression: `SET ${parts.join(', ')}`,
      ExpressionAttributeValues: values,
    }));
    return { statusCode: 200, body: JSON.stringify({ message: 'Model rate updated' }) };
  }

  if (routeKey === 'DELETE /admin/model-rates/{modelId}') {
    const modelId = decodeURIComponent(pathParams.modelId!);
    await deps.ddb.send(new DeleteItemCommand({
      TableName: tableName,
      Key: { modelId: { S: modelId }, SK: { S: '-' } },
    }));
    return { statusCode: 200, body: JSON.stringify({ message: 'Model rate deleted' }) };
  }

  return { statusCode: 400, body: JSON.stringify({ message: 'Unknown route' }) };
}

interface ApiEvent {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  routeKey: string;
  pathParameters?: { modelId?: string };
  body?: string;
}

const ddb = new DynamoDBClient({});

export const handler = async (event: ApiEvent) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  return processModelRates(event.routeKey, process.env.MODEL_RATES_TABLE!, event.pathParameters ?? {}, event.body, { ddb });
};
