import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { match } from './router';
import { billingGate } from './lib/billing-gate';

const notFound = (): APIGatewayProxyResultV2 => ({
  statusCode: 404,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: 'not_found', message: 'No such endpoint.' }),
});

/** The single entry point for every HTTP route. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const { method, path } = event.requestContext.http;
  const found = match(method, path);
  if (!found) return notFound();

  const refused = await billingGate(event, path);
  if (refused) return refused;

  // API Gateway would normally populate this from the route template. With one catch-all
  // route it does not, so the router fills it in and the handlers see what they always saw.
  return found.handler({ ...event, pathParameters: { ...event.pathParameters, ...found.params } });
};
