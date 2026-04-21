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

// ── HTML interpreter ─────────────────────────────────────────────────────────
// Finds string values that contain an HTML <body> fragment anywhere in the
// result (including inside parsed JSON strings) and collects them for a
// dedicated sandboxed HTML preview tab.

function collectHtmlStrings(raw: unknown, results: string[], seen: WeakSet<object>) {
  if (typeof raw === 'string') {
    // If the string looks like a JSON object/array, parse and recurse into it
    // before checking for HTML — handles multiply-encoded JSON payloads.
    const t = raw.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && !seen.has(raw as unknown as object)) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          collectHtmlStrings(parsed, results, seen);
          return;
        }
      } catch { /* not JSON, fall through to HTML check */ }
    }
    if (/<body[\s>][\s\S]*<\/body>/i.test(raw)) results.push(raw);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collectHtmlStrings(item, results, seen);
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  if (seen.has(raw)) return;
  seen.add(raw);
  for (const value of Object.values(raw as Record<string, unknown>)) {
    collectHtmlStrings(value, results, seen);
  }
}

function tryHtmlInterpreter(raw: unknown): ResultInterpretation | null {
  // Prefer scanning the parsed JSON object over the raw MCP envelope.
  // Scanning the raw envelope would also match the entire JSON text string
  // (which contains the HTML as a substring), producing a wrong fragment.
  let dataToScan: unknown = raw;
  if (isMcpContentArray(raw) && raw.length === 1 && raw[0].type === 'text' && typeof raw[0].text === 'string') {
    try { dataToScan = JSON.parse(raw[0].text); } catch { /* not JSON, scan raw */ }
  }

  const htmlFragments: string[] = [];
  collectHtmlStrings(dataToScan, htmlFragments, new WeakSet());
  if (htmlFragments.length === 0) return null;
  return { id: 'html', label: 'HTML', data: htmlFragments };
}

// ── Registry ──────────────────────────────────────────────────────────────────
// Add new interpreters here as additional formats are supported.

const INTERPRETERS: Interpreter[] = [
  tryJsonInterpreter,
  tryHtmlInterpreter,
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
