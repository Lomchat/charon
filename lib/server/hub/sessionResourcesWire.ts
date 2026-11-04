/** What the browser receives from `GET .../resources`.
 *
 * Codex's `app/list` pages through the account's WHOLE connector directory —
 * thousands of Apps, each with icon assets, branding and distribution
 * metadata. Passed through verbatim that was ~7MB per read (≥1MB compressed),
 * fetched at every session open and competing with the transcript on a slow
 * link. The inspector reads six fields of an App; send exactly those.
 */

const APP_FIELDS = ['id', 'name', 'description', 'is_accessible', 'is_enabled', 'install_url'] as const;

type JsonObject = Record<string, any>;

function slimApp(app: unknown): unknown {
  if (!app || typeof app !== 'object') return app;
  const source = app as JsonObject;
  const slim: JsonObject = {};
  for (const key of APP_FIELDS) {
    if (source[key] !== undefined) slim[key] = source[key];
  }
  return slim;
}

export function browserSessionResources(result: JsonObject): JsonObject {
  if (!result || typeof result !== 'object' || !Array.isArray(result.apps)) return result;
  return { ...result, apps: result.apps.map(slimApp) };
}
