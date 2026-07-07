export function processHealth() {
  return { statusCode: 200, body: JSON.stringify({ status: 'ok' }) };
}

export const handler = async () => processHealth();
