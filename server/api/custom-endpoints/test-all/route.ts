import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { cancelEndpointBatch, EndpointBatchBusy, getEndpointBatch, startEndpointBatch } from '@/lib/server/endpointBatch';

export async function GET() {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  return NextResponse.json({ batch: getEndpointBatch() });
}

export async function POST(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    return NextResponse.json({ batch: startEndpointBatch(await req.json()) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start endpoint tests.' },
      { status: error instanceof EndpointBatchBusy ? 409 : 400 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const { id } = await req.json();
    return NextResponse.json({ batch: cancelEndpointBatch(id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not cancel endpoint tests.' }, { status: 400 });
  }
}
