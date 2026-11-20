import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ContractEvent } from '../../../types/events';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { eventsQuerySchema } from '@/lib/apiSchemas';

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'contract-events.json');
const INDEXER_STATE_FILE = path.join(DATA_DIR, 'indexer-state.json');
const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

interface IndexerState {
  sourceLedgerCursor?: number | null;
  latestKnownLedger?: number | null;
  updatedAt?: string | null;
}

interface FreshnessMetadata {
  sourceLedgerCursor: number | null;
  indexedAt: string | null;
  isStale: boolean;
}

function readFreshnessMetadata(): FreshnessMetadata {
  const fallback: FreshnessMetadata = {
    sourceLedgerCursor: null,
    indexedAt: null,
    isStale: true,
  };

  try {
    if (!fs.existsSync(INDEXER_STATE_FILE)) return fallback;

    const state: IndexerState = JSON.parse(
      fs.readFileSync(INDEXER_STATE_FILE, 'utf8'),
    );

    const cursor =
      typeof state.sourceLedgerCursor === 'number'
        ? state.sourceLedgerCursor
        : null;
    const latest =
      typeof state.latestKnownLedger === 'number'
        ? state.latestKnownLedger
        : null;

    return {
      sourceLedgerCursor: cursor,
      indexedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
      isStale: cursor === null || latest === null || cursor < latest,
    };
  } catch (error) {
    console.error('Error reading indexer freshness metadata:', error);
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/events', RATE_LIMIT);
  if (limited) return limited;

  try {
    const { searchParams } = new URL(request.url);

    const validationResult = eventsQuerySchema.safeParse({
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Validation failed',
          errors: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { limit, offset } = validationResult.data;

    const freshness = readFreshnessMetadata();

    if (!fs.existsSync(EVENTS_FILE)) {
      return NextResponse.json({
        events: [],
        total: 0,
        limit,
        offset,
        ...freshness,
      });
    }

    const fileContent = fs.readFileSync(EVENTS_FILE, 'utf8');
    const events: ContractEvent[] = JSON.parse(fileContent);
    
    // Paginate and return
    const paginatedEvents = events.slice(offset, offset + limit);

    return NextResponse.json({
      events: paginatedEvents,
      total: events.length,
      limit,
      offset,
      ...freshness,
    });
  } catch (error) {
    console.error('Error fetching indexed events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch contract activity events' },
      { status: 500 }
    );
  }
}
