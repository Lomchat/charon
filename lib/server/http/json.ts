/** `Response.json` with the body checked against `T` (route answers typed in
 *  lib/types/api.ts). */
export function json<T>(body: T, init?: ResponseInit): Response {
  return Response.json(body, init);
}
