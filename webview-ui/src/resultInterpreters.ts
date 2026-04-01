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

function isMcpContentArray(raw: unknown): raw is Array<{ type: string; text?: string }> {
  return (
    Array.isArray(raw) &&
    raw.every(item => typeof item === 'object' && item !== null && 'type' in item)
  );
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
