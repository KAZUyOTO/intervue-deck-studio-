import { timingSafeEqual } from 'node:crypto';
import { supabaseHealth } from '@/lib/supabase-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(req.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await supabaseHealth();
    return Response.json({ ok: true, checkedAt: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
