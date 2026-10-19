import { NextResponse } from 'next/server';
import { parseFileKeys, syncFromFigma } from '@/lib/figma';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers.get('x-admin-key') !== adminKey) {
    return NextResponse.json({ error: 'Wrong passcode.' }, { status: 401 });
  }
  const token = process.env.FIGMA_TOKEN;
  const fileUrl = process.env.FIGMA_FILE_URL;
  if (!token || !fileUrl) {
    return NextResponse.json(
      { error: 'Figma is not connected yet. Add FIGMA_TOKEN and FIGMA_FILE_URL to the project settings.' },
      { status: 400 },
    );
  }
  try {
    const manifest = await syncFromFigma({ token, files: parseFileKeys(fileUrl) });
    return NextResponse.json({
      ok: true,
      decks: manifest.decks.map((d) => ({ name: d.name, slides: d.slides.length })),
      syncedAt: manifest.syncedAt,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Sync failed.' }, { status: 500 });
  }
}
