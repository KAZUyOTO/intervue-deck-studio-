import { NextResponse } from 'next/server';

/** The Figma plugin calls these routes from inside Figma (origin "null"), so they allow any origin. */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-key',
  'access-control-max-age': '86400',
};

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: CORS });

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export function authorized(req: Request) {
  const key = process.env.ADMIN_KEY;
  return !key || req.headers.get('x-admin-key') === key;
}

export const SAFE_SEGMENT = /^[A-Za-z0-9][\w.-]{0,100}$/;

export const pubPrefix = (slug: string, id: string) => `decks/pub/${slug}/${id}/`;
