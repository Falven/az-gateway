import { HEADER_KEYS } from '../../globals';
import { Params, Targets } from '../../types/requestBody';
import {
  CacheService as SharedCacheService,
  getSessionCache,
} from '../../shared/services/cache';

const STICKY_SESSION_DEFAULT_TTL_SECONDS = 3600;
const STICKY_SESSION_NAMESPACE = 'sticky-load-balance';

type StickyCacheEntry = {
  targetOriginalIndex: number;
  expiresAt: number;
};

type StickySelection = {
  index: number;
  provider: Targets;
};

type StickySessionConfig = {
  hashFields?: string[];
  ttl?: number;
};

const stickySessionMemoryCache = new Map<string, StickyCacheEntry>();
let stickySessionCacheClient: SharedCacheService | null | undefined;

function getStickySessionCacheClient(): SharedCacheService | null {
  if (stickySessionCacheClient !== undefined) {
    return stickySessionCacheClient;
  }

  try {
    stickySessionCacheClient = getSessionCache();
  } catch (_error) {
    stickySessionCacheClient = null;
  }

  return stickySessionCacheClient;
}

function normalizeStickyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function getNestedValue(source: unknown, path: string): unknown {
  if (!path) return undefined;

  const pathParts = path.split('.').filter(Boolean);
  let current: unknown = source;

  for (const part of pathParts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

function parseMetadataFromHeaders(
  requestHeaders: Record<string, string>
): Record<string, unknown> {
  try {
    const metadata = JSON.parse(requestHeaders[HEADER_KEYS.METADATA] ?? '{}');
    if (metadata && typeof metadata === 'object') {
      return metadata as Record<string, unknown>;
    }
  } catch (_error) {}

  return {};
}

function getStickyFieldValue(
  field: string,
  request: Params | FormData | ReadableStream | ArrayBuffer,
  requestHeaders: Record<string, string>,
  metadata: Record<string, unknown>
): string | null {
  const normalizedField = field.trim();
  if (!normalizedField) return null;

  if (normalizedField.startsWith('headers.')) {
    const headerPath = normalizedField.slice('headers.'.length);
    return normalizeStickyValue(requestHeaders[headerPath.toLowerCase()]);
  }

  if (normalizedField.startsWith('metadata.')) {
    const metadataPath = normalizedField.slice('metadata.'.length);
    return normalizeStickyValue(getNestedValue(metadata, metadataPath));
  }

  const requestObject =
    request &&
    typeof request === 'object' &&
    !(request instanceof FormData) &&
    !(request instanceof ReadableStream) &&
    !(request instanceof ArrayBuffer)
      ? (request as Record<string, unknown>)
      : undefined;

  const fromRequest = normalizeStickyValue(
    getNestedValue(requestObject, normalizedField)
  );
  if (fromRequest) {
    return fromRequest;
  }

  return normalizeStickyValue(requestHeaders[normalizedField.toLowerCase()]);
}

function computeStickyHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildStickyCacheKey(
  currentJsonPath: string,
  stickyId: string
): string {
  return `${currentJsonPath}:${computeStickyHash(stickyId)}`;
}

function getTargetByOriginalIndex(
  targets: Targets[],
  originalIndex: number
): StickySelection | null {
  for (const [index, provider] of targets.entries()) {
    const providerOriginalIndex = provider.originalIndex ?? index;
    if (providerOriginalIndex === originalIndex && (provider.weight ?? 0) > 0) {
      return { index, provider };
    }
  }
  return null;
}

export async function selectTargetWithStickySession({
  targets,
  stickySession,
  request,
  requestHeaders,
  currentJsonPath,
}: {
  targets: Targets[];
  stickySession?: StickySessionConfig;
  request: Params | FormData | ReadableStream | ArrayBuffer;
  requestHeaders: Record<string, string>;
  currentJsonPath: string;
}): Promise<StickySelection | null> {
  const totalWeight = targets.reduce(
    (sum: number, provider: Targets) => sum + (provider.weight ?? 0),
    0
  );

  const stickyHashFields = Array.isArray(stickySession?.hashFields)
    ? stickySession.hashFields.filter(
        (field: unknown): field is string =>
          typeof field === 'string' && field.trim().length > 0
      )
    : [];
  const stickyTtlSeconds =
    typeof stickySession?.ttl === 'number' && stickySession.ttl > 0
      ? Math.floor(stickySession.ttl)
      : STICKY_SESSION_DEFAULT_TTL_SECONDS;

  let stickyCacheKey: string | null = null;
  let selectedTarget: StickySelection | null = null;
  let shouldPersistStickyAssignment = false;

  if (stickyHashFields.length > 0 && totalWeight > 0) {
    const metadata = parseMetadataFromHeaders(requestHeaders);
    const stickyParts = stickyHashFields.map((field: string) => {
      const value = getStickyFieldValue(
        field,
        request,
        requestHeaders,
        metadata
      );
      if (!value) return null;
      return `${field}:${value}`;
    });

    const hasAllStickyFields = stickyParts.every(
      (value: string | null): value is string => value !== null
    );

    if (hasAllStickyFields) {
      stickyCacheKey = buildStickyCacheKey(
        currentJsonPath,
        stickyParts.join('|')
      );

      const now = Date.now();
      const memoryEntry = stickySessionMemoryCache.get(stickyCacheKey);
      if (memoryEntry && memoryEntry.expiresAt > now) {
        selectedTarget = getTargetByOriginalIndex(
          targets,
          memoryEntry.targetOriginalIndex
        );
      } else if (memoryEntry) {
        stickySessionMemoryCache.delete(stickyCacheKey);
      }

      if (!selectedTarget) {
        const stickyCacheClient = getStickySessionCacheClient();
        if (stickyCacheClient) {
          try {
            const cached = await stickyCacheClient.get<StickyCacheEntry>(
              stickyCacheKey,
              STICKY_SESSION_NAMESPACE
            );
            if (cached && cached.expiresAt > now) {
              selectedTarget = getTargetByOriginalIndex(
                targets,
                cached.targetOriginalIndex
              );
              if (selectedTarget) {
                stickySessionMemoryCache.set(stickyCacheKey, cached);
              }
            }
          } catch (_error) {
            // Best effort: sticky should keep working with in-memory cache.
          }
        }
      }
    }
  }

  if (!selectedTarget && totalWeight > 0) {
    let randomWeight = Math.random() * totalWeight;
    for (const [index, provider] of targets.entries()) {
      const providerWeight = provider.weight ?? 0;
      if (randomWeight < providerWeight) {
        selectedTarget = { index, provider };
        shouldPersistStickyAssignment = Boolean(stickyCacheKey);
        break;
      }
      randomWeight -= providerWeight;
    }
  }

  if (selectedTarget && stickyCacheKey && shouldPersistStickyAssignment) {
    const originalIndex =
      selectedTarget.provider.originalIndex ?? selectedTarget.index;
    const expiresAt = Date.now() + stickyTtlSeconds * 1000;
    const entryToStore: StickyCacheEntry = {
      targetOriginalIndex: originalIndex,
      expiresAt,
    };
    stickySessionMemoryCache.set(stickyCacheKey, entryToStore);

    const stickyCacheClient = getStickySessionCacheClient();
    if (stickyCacheClient) {
      try {
        await stickyCacheClient.setWithTtl(
          stickyCacheKey,
          entryToStore,
          stickyTtlSeconds,
          STICKY_SESSION_NAMESPACE
        );
      } catch (_error) {
        // Best effort: keep serving with in-memory sticky cache.
      }
    }
  }

  return selectedTarget;
}
