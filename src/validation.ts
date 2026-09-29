export const LIMITS = {
  EVENT_TYPE_MAX: 128,
  SESSION_ID_MAX: 128,
  USER_ID_MAX: 128,
  URL_MAX: 2048,
  REFERRER_MAX: 2048,
  COUNTRY_MAX: 16,
  UTM_MAX: 256,
  PROP_KEY_MAX: 64,
  PROP_VAL_STRING_MAX: 1024,
  PROP_KEYS_MAX: 50,
  PROP_DEPTH_MAX: 3,
  PROP_BYTES_MAX: 16 * 1024,
  BATCH_MAX: 50
} as const;

export interface IngestEvent {
  event_type: string;
  session_id?: string | null;
  user_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  country?: string | null;
  properties?: Record<string, unknown>;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
}

export class ValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string = 'INVALID_PAYLOAD') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function validatePropertyValue(val: unknown, currentDepth: number, keyCounter: { count: number }): unknown {
  if (val === null) return null;

  if (typeof val === 'string') {
    if (val.length > LIMITS.PROP_VAL_STRING_MAX) {
      throw new ValidationError(`Property string value exceeds max length of ${LIMITS.PROP_VAL_STRING_MAX}`, 'PROP_VALUE_TOO_LONG');
    }
    return val;
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new ValidationError('Property numeric value must be finite', 'INVALID_PROPERTY_VALUE');
    }
    return val;
  }

  if (typeof val === 'boolean') {
    return val;
  }

  if (currentDepth >= LIMITS.PROP_DEPTH_MAX) {
    throw new ValidationError(`Property nesting exceeds max depth of ${LIMITS.PROP_DEPTH_MAX}`, 'PROP_DEPTH_EXCEEDED');
  }

  if (Array.isArray(val)) {
    return val.map((item) => validatePropertyValue(item, currentDepth + 1, keyCounter));
  }

  if (isPlainObject(val)) {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      keyCounter.count += 1;
      if (keyCounter.count > LIMITS.PROP_KEYS_MAX) {
        throw new ValidationError(`Properties exceed max key count of ${LIMITS.PROP_KEYS_MAX}`, 'PROP_KEY_COUNT_EXCEEDED');
      }
      if (k.length > LIMITS.PROP_KEY_MAX) {
        throw new ValidationError(`Property key "${k}" exceeds max length of ${LIMITS.PROP_KEY_MAX}`, 'PROP_KEY_TOO_LONG');
      }
      sanitizedObj[k] = validatePropertyValue(v, currentDepth + 1, keyCounter);
    }
    return sanitizedObj;
  }

  throw new ValidationError(`Unsupported property value type: ${typeof val}`, 'INVALID_PROPERTY_TYPE');
}

export function validateProperties(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new ValidationError('Event properties must be an object', 'INVALID_PROPERTIES');
  }

  const keyCounter = { count: 0 };
  const validated = validatePropertyValue(raw, 0, keyCounter) as Record<string, unknown>;

  try {
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized) > LIMITS.PROP_BYTES_MAX) {
      throw new ValidationError(`Serialized properties exceed max size of ${LIMITS.PROP_BYTES_MAX} bytes`, 'PROP_SIZE_EXCEEDED');
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Properties cannot be serialized to JSON', 'INVALID_PROPERTIES');
  }

  return validated;
}

function sanitizeOptionalString(val: unknown, fieldName: string, maxLen: number): string | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val !== 'string') {
    throw new ValidationError(`Field "${fieldName}" must be a string`, 'INVALID_FIELD_TYPE');
  }
  if (val.length > maxLen) {
    throw new ValidationError(`Field "${fieldName}" exceeds max length of ${maxLen}`, 'STRING_TOO_LONG');
  }
  return val;
}

export function validateEvent(raw: unknown): IngestEvent {
  if (!isPlainObject(raw)) {
    throw new ValidationError('Event must be a JSON object', 'INVALID_EVENT_OBJECT');
  }

  const rawEventType = raw.event_type;
  if (typeof rawEventType !== 'string' || !rawEventType.trim()) {
    throw new ValidationError('Field "event_type" is required and cannot be empty', 'MISSING_EVENT_TYPE');
  }
  const event_type = rawEventType.trim();
  if (event_type.length > LIMITS.EVENT_TYPE_MAX) {
    throw new ValidationError(`Field "event_type" exceeds max length of ${LIMITS.EVENT_TYPE_MAX}`, 'EVENT_TYPE_TOO_LONG');
  }

  const session_id = sanitizeOptionalString(raw.session_id, 'session_id', LIMITS.SESSION_ID_MAX);
  const user_id = sanitizeOptionalString(raw.user_id, 'user_id', LIMITS.USER_ID_MAX);
  const url = sanitizeOptionalString(raw.url, 'url', LIMITS.URL_MAX);
  const referrer = sanitizeOptionalString(raw.referrer, 'referrer', LIMITS.REFERRER_MAX);
  const country = sanitizeOptionalString(raw.country, 'country', LIMITS.COUNTRY_MAX);

  const utm_source = sanitizeOptionalString(raw.utm_source, 'utm_source', LIMITS.UTM_MAX);
  const utm_medium = sanitizeOptionalString(raw.utm_medium, 'utm_medium', LIMITS.UTM_MAX);
  const utm_campaign = sanitizeOptionalString(raw.utm_campaign, 'utm_campaign', LIMITS.UTM_MAX);
  const utm_term = sanitizeOptionalString(raw.utm_term, 'utm_term', LIMITS.UTM_MAX);
  const utm_content = sanitizeOptionalString(raw.utm_content, 'utm_content', LIMITS.UTM_MAX);

  const properties = validateProperties(raw.properties);

  return {
    event_type,
    session_id,
    user_id,
    url,
    referrer,
    country,
    properties,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content
  };
}

export function validateIngestBatch(payload: unknown): IngestEvent[] {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw new ValidationError('Batch payload cannot be empty', 'EMPTY_BATCH');
    }
    if (payload.length > LIMITS.BATCH_MAX) {
      throw new ValidationError(`Batch size exceeds maximum of ${LIMITS.BATCH_MAX} events`, 'BATCH_TOO_LARGE');
    }
    return payload.map((item, idx) => {
      try {
        return validateEvent(item);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`Batch item [${idx}] invalid: ${err.message}`, err.code);
        }
        throw err;
      }
    });
  }

  if (isPlainObject(payload)) {
    return [validateEvent(payload)];
  }

  throw new ValidationError('Payload must be a JSON event object or array of events', 'INVALID_PAYLOAD');
}
