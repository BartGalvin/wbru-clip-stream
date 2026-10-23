import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const aliases: Record<string, string> = {
  '/': '/stream.html',
  '/tag': '/tag.html',
  '/stream': '/stream.html',
  '/builder': '/builder.html',
  '/playout': '/playout.html',
};

export function resolvePageAlias(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined;
  try {
    const url = new URL(requestUrl, 'http://localhost');
    const target = aliases[url.pathname];
    return target ? `${target}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}

// Mirror nginx's extensionless page routes in dev and preview.
function pageAliases(): Plugin {
  const redirect = (
    request: { url?: string },
    response: {
      statusCode: number;
      setHeader: (header: string, value: string) => void;
      end: () => void;
    },
    next: () => void,
  ): void => {
    const target = resolvePageAlias(request.url);
    if (target) {
      response.statusCode = 302;
      response.setHeader('Location', target);
      response.end();
      return;
    }
    next();
  };
  return {
    name: 'page-aliases',
    configureServer(server) {
      server.middlewares.use(redirect);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ['browser'],
  },
  plugins: [svelte(), pageAliases()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DEV_WEB_PORT ?? 5173),
    strictPort: true,
    open: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      ...(process.env.DEV_MEDIA_ORIGIN
        ? {
            '^/clips/': {
              target: process.env.DEV_MEDIA_ORIGIN,
              // Remote development uses this connection only to read media.
              bypass: (request: { method?: string }) =>
                request.method === 'GET' || request.method === 'HEAD' ? undefined : false,
            },
          }
        : {}),
    },
  },
  build: {
    copyPublicDir: false,
    rollupOptions: {
      input: {
        tag: resolve(__dirname, 'tag.html'),
        stream: resolve(__dirname, 'stream.html'),
        builder: resolve(__dirname, 'builder.html'),
        playout: resolve(__dirname, 'playout.html'),
      },
    },
  },
});
