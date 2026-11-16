import { handleApiRequest } from '@/server/apiApp';

// Next hands every /api request to the Hono router (server/apiRouter.ts);
// the routes themselves live in server/api/.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function handle(req: Request): Promise<Response> {
  return handleApiRequest(req);
}

export {
  handle as GET, handle as HEAD, handle as POST, handle as PUT,
  handle as PATCH, handle as DELETE, handle as OPTIONS,
};
