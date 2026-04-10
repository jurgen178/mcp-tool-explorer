import { useMemo, useState } from 'react';
import CopyButton from './CopyButton';

type TokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punc' | 'ws';
interface Token { kind: TokenKind; value: string; }

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    // whitespace
    if (/[ \t\n\r]/.test(ch)) {
      let ws = '';
      while (i < input.length && /[ \t\n\r]/.test(input[i])) ws += input[i++];
      tokens.push({ kind: 'ws', value: ws });
      continue;
    }

    // string
    if (ch === '"') {
      let str = '"';
      i++;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          str += input[i] + input[i + 1]; i += 2;
        } else if (input[i] === '"') {
          str += '"'; i++; break;
        } else {
          str += input[i++];
        }
      }
      // peek ahead past whitespace to check if followed by ':'
      let j = i;
      while (j < input.length && /[ \t\n\r]/.test(input[j])) j++;
      tokens.push({ kind: input[j] === ':' ? 'key' : 'string', value: str });
      continue;
    }

    // number
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let num = '';
      while (i < input.length && /[-0-9.eE+]/.test(input[i])) num += input[i++];
      tokens.push({ kind: 'number', value: num });
      continue;
    }

    // keywords
    if (input.startsWith('true', i))  { tokens.push({ kind: 'boolean', value: 'true' });  i += 4; continue; }
    if (input.startsWith('false', i)) { tokens.push({ kind: 'boolean', value: 'false' }); i += 5; continue; }
    if (input.startsWith('null', i))  { tokens.push({ kind: 'null',    value: 'null' });  i += 4; continue; }

    tokens.push({ kind: 'punc', value: ch }); i++;
  }
  return tokens;
}

interface Props {
  data: unknown;
  isError?: boolean;
  allowSmartView?: boolean;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

function tryParseEmbeddedJson(value: string): Record<string, unknown> | unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isContainer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEmbeddedJson(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') {
    const embedded = tryParseEmbeddedJson(value);
    return embedded ? normalizeEmbeddedJson(embedded, seen) : value;
  }
  if (!isContainer(value)) return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const normalizedArray: unknown[] = [];
    seen.set(value, normalizedArray);
    for (const item of value) normalizedArray.push(normalizeEmbeddedJson(item, seen));
    return normalizedArray;
  }

  const normalizedObject: Record<string, unknown> = {};
  seen.set(value, normalizedObject);
  for (const [key, entry] of Object.entries(value)) {
    normalizedObject[key] = normalizeEmbeddedJson(entry, seen);
  }
  return normalizedObject;
}

function renderPrimitive(value: unknown) {
  if (typeof value === 'string') return <span className="jt-string">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="jt-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="jt-boolean">{String(value)}</span>;
  if (value === null) return <span className="jt-null">null</span>;
  return <span className="jt-string">{JSON.stringify(value) ?? String(value)}</span>;
}

function renderKey(name?: string) {
  if (name === undefined) return null;
  return (
    <>
      <span className="jt-key">{JSON.stringify(name)}</span>
      <span className="jt-punc">: </span>
    </>
  );
}

function getCollapsedSummary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '' : ` ${value.length} item${value.length === 1 ? '' : 's'} `;
  }
  const count = Object.keys(value).length;
  return count === 0 ? '' : ` ${count} key${count === 1 ? '' : 's'} `;
}

interface SmartJsonNodeProps {
  name?: string;
  value: unknown;
  trailingComma: boolean;
}

function SmartJsonNode(props: SmartJsonNodeProps) {
  return isContainer(props.value)
    ? <SmartJsonContainerNode {...props} value={props.value} />
    : <SmartJsonPrimitiveNode {...props} />;
}

function SmartJsonPrimitiveNode({ name, value, trailingComma }: SmartJsonNodeProps) {
  if (typeof value === 'string') {
    const embedded = tryParseEmbeddedJson(value);
    if (embedded) {
      return (
        <SmartEmbeddedJsonNode
          name={name}
          embedded={embedded}
          trailingComma={trailingComma}
        />
      );
    }
  }

  return (
    <div className="json-tree-line">
      {renderKey(name)}
      {renderPrimitive(value)}
      {trailingComma && <span className="jt-punc">,</span>}
    </div>
  );
}

interface SmartEmbeddedJsonNodeProps {
  name?: string;
  embedded: Record<string, unknown> | unknown[];
  trailingComma: boolean;
}

function SmartEmbeddedJsonNode({ name, embedded, trailingComma }: SmartEmbeddedJsonNodeProps) {
  return <SmartJsonContainerNode name={name} value={embedded} trailingComma={trailingComma} />;
}

function SmartJsonContainerNode({ name, value, trailingComma }: SmartJsonNodeProps & { value: Record<string, unknown> | unknown[] }) {
  const [expanded, setExpanded] = useState(true);
  const isArray = Array.isArray(value);
  const entries = isArray ? value : Object.entries(value);
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const summary = getCollapsedSummary(value);

  if (entries.length === 0) {
    return (
      <div className="json-tree-line">
        {renderKey(name)}
        <span className="jt-punc">{open}{close}</span>
        {trailingComma && <span className="jt-punc">,</span>}
      </div>
    );
  }

  return (
    <div className="json-tree-node">
      <div className="json-tree-line">
        <button
          type="button"
          className="json-disclosure"
          onClick={() => setExpanded(openState => !openState)}
          title={expanded ? 'Collapse section' : 'Expand section'}
        >
          {expanded ? '▼' : '▶'}
        </button>
        {renderKey(name)}
        <span className="jt-punc">{open}</span>
        {!expanded && (
          <>
            <span className="json-collapsed-preview">{summary}</span>
            <span className="jt-punc">{close}</span>
            {trailingComma && <span className="jt-punc">,</span>}
          </>
        )}
      </div>
      {expanded && (
        <div className="json-tree-children">
          {isArray
            ? value.map((item, index) => (
                <SmartJsonNode
                  key={index}
                  value={item}
                  trailingComma={index < value.length - 1}
                />
              ))
            : Object.entries(value).map(([childName, childValue], index, array) => (
                <SmartJsonNode
                  key={childName}
                  name={childName}
                  value={childValue}
                  trailingComma={index < array.length - 1}
                />
              ))}
          <div className="json-tree-line">
            <span className="jt-punc">{close}</span>
            {trailingComma && <span className="jt-punc">,</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JsonViewer({ data, isError, allowSmartView = true }: Props) {
  const raw = useMemo(() => JSON.stringify(data, null, 2) ?? '', [data]);
  const canUseSmartView = allowSmartView && isContainer(data);
  const smartCopyText = useMemo(() => JSON.stringify(normalizeEmbeddedJson(data), null, 2) ?? '', [data]);
  const copyText = canUseSmartView ? smartCopyText : raw;

  const tokens = useMemo(() => {
    try { return tokenize(raw); } catch { return null; }
  }, [raw]);

  return (
    <div className="json-viewer-wrap">
      <CopyButton text={copyText} />
      {!canUseSmartView ? (
        <pre className={`json-box${isError ? ' is-error' : ''}`}>
          {tokens
            ? tokens.map((t, i) =>
                t.kind === 'ws'
                  ? t.value
                  : <span key={i} className={`jt-${t.kind}`}>{t.value}</span>
              )
            : raw}
        </pre>
      ) : (
        <div className={`json-box json-tree-box${isError ? ' is-error' : ''}`}>
          <div className="json-tree" role="tree">
            <SmartJsonNode value={data} trailingComma={false} />
          </div>
        </div>
      )}
    </div>
  );
}
