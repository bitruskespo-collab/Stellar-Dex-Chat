import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ContractEvent } from '../../../types/events';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { eventsQuerySchema } from '@/lib/apiSchemas';

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'contract-events.json');
const ACTIVE_PROJECTION_FILE = path.join(DATA_DIR, 'contract-events.active.json');
const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

interface ActiveProjectionPointer {
  version: number;
  checksum: string;
  file: string;
  rebuiltAt?: string;
}

interface ResolvedProjection {
  events: ContractEvent[];
  projectionVersion: number | null;
  projectionChecksum: string | null;
  rebuildInProgress: boolean;
}

function readActivePointer(): ActiveProjectionPointer | null {
  try {
    if (!fs.existsSync(ACTIVE_PROJECTION_FILE)) return null;
    const raw = fs.readFileSync(ACTIVE_PROJECTION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ActiveProjectionPointer>;
    if (
      typeof parsed.version !== 'number' ||
      typeof parsed.checksum !== 'string' ||
      typeof parsed.file !== 'string'
    ) {
      return null;
    }
    return {
      version: parsed.version,
      checksum: parsed.checksum,
      file: parsed.file,
      rebuiltAt: parsed.rebuiltAt,
    };
  } catch (error) {
    console.error('Error reading active projection pointer:', error);
    return null;
  }
}

function resolveProjection(): ResolvedProjection {
  const pointer = readActivePointer();

  if (pointer) {
    // Resolve the pointer's file relative to DATA_DIR and refuse path escapes.
    const resolved = path.resolve(DATA_DIR, pointer.file);
    const relative = path.relative(DATA_DIR, resolved);
    const isInsideDataDir = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

    if (isInsideDataDir && fs.existsSync(resolved)) {
      try {
        const events = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ContractEvent[];
        return {
          events,
          projectionVersion: pointer.version,
          projectionChecksum: pointer.checksum,
          rebuildInProgress: false,
        };
      } catch (error) {
        console.error('Error reading active projection file:', error);
      }
    }
  }

  // Fallback: legacy single-file projection (no version metadata available).
  if (!fs.existsSync(EVENTS_FILE)) {
    return {
      events: [],
      projectionVersion: pointer?.version ?? null,
      projectionChecksum: pointer?.checksum ?? null,
      rebuildInProgress: pointer !== null,
    };
  }

  const events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) as ContractEvent[];
  return {
    events,
    projectionVersion: pointer?.version ?? null,
    projectionChecksum: pointer?.checksum ?? null,
    // A pointer exists but its target was unreadable: a rebuild is likely in flight.
    rebuildInProgress: pointer !== null,
  };
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

    const { events, projectionVersion, projectionChecksum, rebuildInProgress } =
      resolveProjection();

    // Paginate and return
    const paginatedEvents = events.slice(offset, offset + limit);

    return NextResponse.json({
      events: paginatedEvents,
      total: events.length,
      limit,
      offset,
      projectionVersion,
      projectionChecksum,
      rebuildInProgress,
    });
  } catch (error) {
    console.error('Error fetching indexed events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch contract activity events' },
      { status: 500 }
    );
  }
}
