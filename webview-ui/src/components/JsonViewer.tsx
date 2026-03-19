import { useMemo } from 'react';
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
}

export default function JsonViewer({ data, isError }: Props) {
  const raw = useMemo(() => JSON.stringify(data, null, 2) ?? '', [data]);
  const tokens = useMemo(() => {
    try { return tokenize(raw); } catch { return null; }
  }, [raw]);

  return (
    <div className="json-viewer-wrap">
      <CopyButton text={raw} />
      <pre className={`json-box${isError ? ' is-error' : ''}`}>
        {tokens
          ? tokens.map((t, i) =>
              t.kind === 'ws'
                ? t.value
                : <span key={i} className={`jt-${t.kind}`}>{t.value}</span>
            )
          : raw}
      </pre>
    </div>
  );
}
