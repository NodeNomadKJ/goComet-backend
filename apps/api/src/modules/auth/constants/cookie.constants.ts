import type { CookieSerializeOptions } from '@fastify/cookie';

const isProduction = process.env.NODE_ENV === 'production';

export const ACCESS_TOKEN_COOKIE = {
  name: 'access_token',
  options: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 900, // 15 minutes
  } satisfies CookieSerializeOptions,
} as const;

export const REFRESH_TOKEN_COOKIE = {
  name: 'refresh_token',
  options: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/auth/refresh', // narrow path — not sent on every request
    maxAge: 7 * 24 * 60 * 60, // 7 days
  } satisfies CookieSerializeOptions,
} as const;
