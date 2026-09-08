/**
 * Swagger / OpenAPI UI (Node.js-style).
 *
 * Serves:
 *   GET /openapi.json          → the OpenAPI spec (machine-readable)
 *   GET /docs                  → Swagger UI page to browse & try the APIs
 *   GET /swagger-assets/*      → swagger-ui-dist static assets (served locally, no CDN)
 */
import { Hono } from 'hono';
import { join } from 'node:path';
import { openapi } from './openapi';

// This file lives at <root>/src/swagger.ts, so node_modules is one level up.
const SWAGGER_DIST = join(import.meta.dir, '..', 'node_modules', 'swagger-ui-dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function mimeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

function docsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Traderverse Subscription API — Swagger Docs</title>
  <link rel="stylesheet" href="/swagger-assets/swagger-ui.css">
  <style>html { box-sizing: border-box; overflow-y: scroll; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-assets/swagger-ui-bundle.js"></script>
  <script src="/swagger-assets/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    };
  </script>
</body>
</html>`;
}

export function registerSwagger(app: Hono): void {
  // 1. The machine-readable spec.
  app.get('/openapi.json', (c) => c.json(openapi));

  // 2. The human-readable Swagger UI page.
  app.get('/docs', (c) =>
    new Response(docsPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
  );

  // 3. swagger-ui-dist static assets (swagger-ui.css / bundle.js / ...).
  app.get('/swagger-assets/*', async (c) => {
    const relative = c.req.path.replace(/^\/swagger-assets\//, '');
    if (!relative || relative.includes('..')) {
      return c.json({ error: 'Not found.' }, 404);
    }
    const file = Bun.file(join(SWAGGER_DIST, relative));
    const exists = await file.exists();
    if (!exists) {
      return c.json({ error: `Asset not found: ${relative}` }, 404);
    }
    return new Response(file as unknown as BodyInit, {
      headers: { 'Content-Type': mimeFor(relative) },
    });
  });
}
