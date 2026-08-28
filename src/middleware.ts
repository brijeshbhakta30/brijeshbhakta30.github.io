import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware((context, next) => {
  const match = context.url.pathname.match(/^\/tools\/scrum-poker\/([^/]+)\/?$/i);
  if (!match) return next();

  const target = new URL('/tools/scrum-poker', context.url);
  target.searchParams.set('room', match[1]);
  return context.rewrite(target);
});
