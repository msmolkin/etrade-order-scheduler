export type AutoAuthWebhookPayloadExtraction = {
  code: string | null;
  sessionId: string | null;
  codeSource: string | null;
  sessionIdSource: string | null;
  error: string | null;
};

type StringField = {
  key: string;
  normalizedKey: string;
  path: string;
  value: string;
};

const EXPLICIT_CODE_KEYS = new Set([
  'code',
  'otp',
  'twofactorcode',
  'verificationcode',
  'securitycode',
  'passcode',
  'smscode',
  'onetimecode',
]);

const SESSION_ID_KEYS = new Set([
  'sessionid',
  'etradesessionid',
  'autoauthsessionid',
]);

const MESSAGE_TEXT_KEYS = new Set([
  'body',
  'message',
  'text',
  'sms',
  'smsbody',
  'content',
  'transcript',
]);

const IGNORED_KEYS = new Set([
  'secret',
  'webhooksecret',
  'signature',
  'authorization',
  'password',
]);

const MESSAGE_HINTS = [
  'etrade',
  'e*trade',
  'verification code',
  'security code',
  'login code',
  'one-time code',
  'otp',
  'passcode',
  'code',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectStringFields(value: unknown, path = 'payload', propertyKey = 'payload', depth = 0): StringField[] {
  if (depth > 5 || value == null) {
    return [];
  }

  const normalizedKey = normalizeKey(propertyKey);
  if (IGNORED_KEYS.has(normalizedKey)) {
    return [];
  }

  if (typeof value === 'string') {
    return [{
      key: propertyKey,
      normalizedKey,
      path,
      value,
    }];
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return [{
      key: propertyKey,
      normalizedKey,
      path,
      value: String(value),
    }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectStringFields(entry, `${path}[${index}]`, propertyKey, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([key, nestedValue]) => collectStringFields(nestedValue, `${path}.${key}`, key, depth + 1));
}

function extractUniqueSixDigitCodes(text: string): string[] {
  const matches = text.match(/\b\d{6}\b/g) ?? [];
  return Array.from(new Set(matches));
}

function hasMessageHint(text: string): boolean {
  const normalized = text.toLowerCase();
  return MESSAGE_HINTS.some((hint) => normalized.includes(hint));
}

function chooseSingleCode(fields: StringField[]): { code: string | null; source: string | null; error: string | null } {
  const unique = new Map<string, string>();

  for (const field of fields) {
    const codes = extractUniqueSixDigitCodes(field.value);
    for (const code of codes) {
      if (!unique.has(code)) {
        unique.set(code, field.path);
      }
    }
  }

  if (unique.size === 1) {
    const [[code, source]] = Array.from(unique.entries());
    return { code, source, error: null };
  }

  if (unique.size > 1) {
    return {
      code: null,
      source: null,
      error: `Ambiguous webhook payload: found multiple 6-digit codes (${Array.from(unique.keys()).join(', ')}).`,
    };
  }

  return { code: null, source: null, error: null };
}

export function extractAutoAuthWebhookPayload(payload: unknown): AutoAuthWebhookPayloadExtraction {
  const fields = collectStringFields(payload);

  let sessionId: string | null = null;
  let sessionIdSource: string | null = null;
  for (const field of fields) {
    if (!SESSION_ID_KEYS.has(field.normalizedKey)) {
      continue;
    }

    const candidate = field.value.trim();
    if (!candidate) {
      continue;
    }

    sessionId = candidate;
    sessionIdSource = field.path;
    break;
  }

  const explicitCodeFields = fields.filter((field) => EXPLICIT_CODE_KEYS.has(field.normalizedKey));
  const explicitChoice = chooseSingleCode(explicitCodeFields);
  if (explicitChoice.code) {
    return {
      code: explicitChoice.code,
      sessionId,
      codeSource: explicitChoice.source,
      sessionIdSource,
      error: null,
    };
  }
  if (explicitChoice.error) {
    return {
      code: null,
      sessionId,
      codeSource: null,
      sessionIdSource,
      error: explicitChoice.error,
    };
  }

  const messageFields = fields.filter((field) => {
    if (MESSAGE_TEXT_KEYS.has(field.normalizedKey)) {
      return true;
    }
    return hasMessageHint(field.value);
  });
  const messageChoice = chooseSingleCode(messageFields);
  if (messageChoice.code) {
    return {
      code: messageChoice.code,
      sessionId,
      codeSource: messageChoice.source,
      sessionIdSource,
      error: null,
    };
  }
  if (messageChoice.error) {
    return {
      code: null,
      sessionId,
      codeSource: null,
      sessionIdSource,
      error: messageChoice.error,
    };
  }

  const fallbackChoice = chooseSingleCode(fields);
  return {
    code: fallbackChoice.code,
    sessionId,
    codeSource: fallbackChoice.source,
    sessionIdSource,
    error: fallbackChoice.error,
  };
}
