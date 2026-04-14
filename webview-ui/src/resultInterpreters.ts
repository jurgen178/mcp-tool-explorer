// ── Result interpretation pipeline ───────────────────────────────────────────
//
// Each interpreter inspects the raw MCP result and, if it recognises the
// format, returns a structured interpretation that the UI can render in a
// dedicated tab.  Add new interpreters to the INTERPRETERS array to support
// additional formats in the future.

export interface ResultInterpretation {
  /** Unique identifier used as the tab key. */
  id: string;
  /** Human-readable label shown on the tab button. */
  label: string;
  /** The interpreted data to hand to the renderer. */
  data: unknown;
}

type Interpreter = (raw: unknown) => ResultInterpretation | null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMcpContentArray(raw: unknown): raw is Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  return (
    Array.isArray(raw) &&
    raw.every(item => typeof item === 'object' && item !== null && 'type' in item)
  );
}

// ── Text interpreter ─────────────────────────────────────────────────────────
// Collects all text content items into a single "Text" tab.

function isJsonObjectOrArray(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try { const p = JSON.parse(t); return typeof p === 'object' && p !== null; } catch { return false; }
}

function collectTextValues(raw: unknown, texts: string[], seen: WeakSet<object>) {
  if (typeof raw === 'string') {
    if (!isJsonObjectOrArray(raw)) {
      texts.push(raw);
    }
    return;
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      collectTextValues(item, texts, seen);
    }
    return;
  }

  if (typeof raw !== 'object' || raw === null) {
    return;
  }

  if (seen.has(raw)) {
    return;
  }
  seen.add(raw);

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'text' && typeof value === 'string') {
      if (!isJsonObjectOrArray(value)) {
        texts.push(value);
      }
      continue;
    }

    collectTextValues(value, texts, seen);
  }
}

export function extractTextValues(raw: unknown): string[] {
  if (isMcpContentArray(raw)) {
    return raw
      .filter(item => item.type === 'text' && typeof item.text === 'string' && !isJsonObjectOrArray(item.text as string))
      .map(item => item.text as string);
  }

  const texts: string[] = [];
  collectTextValues(raw, texts, new WeakSet<object>());
  return texts;
}

function tryTextInterpreter(raw: unknown): ResultInterpretation | null {
  const texts = extractTextValues(raw);
  if (texts.length === 0) return null;
  return { id: 'text', label: 'Text', data: texts };
}

// ── Image interpreter ─────────────────────────────────────────────────────────
// Collects all image content items into a single "Image" tab.

export interface ImageItem { data: string; mimeType: string; }

function tryImageInterpreter(raw: unknown): ResultInterpretation | null {
  if (!isMcpContentArray(raw)) return null;
  const images: ImageItem[] = raw
    .filter(item => item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')
    .map(item => ({ data: item.data as string, mimeType: item.mimeType as string }));
  if (images.length === 0) return null;
  return { id: 'image', label: 'Image', data: images };
}

// ── JSON interpreter ──────────────────────────────────────────────────────────
// Matches when the result is a single MCP text content item whose text value
// is a valid JSON object or array.

function tryJsonInterpreter(raw: unknown): ResultInterpretation | null {
  if (!isMcpContentArray(raw) || raw.length !== 1) return null;
  const item = raw[0];
  if (item.type !== 'text' || typeof item.text !== 'string') return null;

  const trimmed = item.text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { id: 'json', label: 'JSON', data: parsed };
  } catch {
    return null;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────
// Add new interpreters here as additional formats are supported.

const INTERPRETERS: Interpreter[] = [
  tryJsonInterpreter,
  tryTextInterpreter,
  tryImageInterpreter,
];

/**
 * Runs all registered interpreters against a raw MCP result and returns every
 * interpretation that matched.  An empty array means no special format was
 * detected.
 */
export function interpretResult(raw: unknown): ResultInterpretation[] {
  const results: ResultInterpretation[] = [];
  for (const interpret of INTERPRETERS) {
    const result = interpret(raw);
    if (result) results.push(result);
  }
  return results;
}
