import { defineMiddleware } from 'astro:middleware';

const scrumPokerRoomRoutePattern = /^\/tools\/scrum-poker\/([^/]+)\/?$/i;

export const onRequest = defineMiddleware((context, next) => {
  const match = scrumPokerRoomRoutePattern.exec(context.url.pathname);
  if (!match) return next();

  const target = new URL('/tools/scrum-poker', context.url);
  target.searchParams.set('room', match[1].toUpperCase());
  return context.rewrite(target);
});
