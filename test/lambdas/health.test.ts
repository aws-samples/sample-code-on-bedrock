import { handler } from '../../lambdas/health/index';

test('returns 200 with { status: "ok" }', async () => {
  const result = await handler();
  expect(result).toEqual({
    statusCode: 200,
    body: JSON.stringify({ status: 'ok' }),
  });
});
