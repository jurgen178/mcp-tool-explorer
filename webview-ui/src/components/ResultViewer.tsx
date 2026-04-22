import { useEffect, useMemo, useState } from 'react';
import JsonViewer from './JsonViewer';
import { interpretResult, type ResultInterpretation, type ImageItem } from '../resultInterpreters';

interface Props {
  data: unknown;
  isError?: boolean;
}

const HTML_BASE_STYLE = `<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    margin: 12px 16px;
  }
</style>`;

function injectBaseStyle(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[\s>][^>]*>)/i, `$1\n  ${HTML_BASE_STYLE}`);
  }
  return HTML_BASE_STYLE + '\n' + html;
}

function renderInterpretation(interp: ResultInterpretation) {
  if (interp.id === 'html') {
    return (
      <div className="html-result-list">
        {(interp.data as string[]).map((html, idx) => (
          <iframe
            key={idx}
            srcDoc={injectBaseStyle(html)}
            sandbox=""
            className="html-result"
            title={`HTML preview ${idx + 1}`}
          />
        ))}
      </div>
    );
  }

  if (interp.id === 'text') {
    return (
      <div className="text-result-list">
        {(interp.data as string[]).map((txt, idx) => (
          <pre key={idx} className="text-result">{txt}</pre>
        ))}
      </div>
    );
  }

  if (interp.id === 'image') {
    return (
      <div className="image-result-list">
        {(interp.data as ImageItem[]).map((img, idx) => (
          <img
            key={idx}
            src={`data:${img.mimeType};base64,${img.data}`}
            alt={`Result image ${idx + 1}`}
            className="image-result"
          />
        ))}
      </div>
    );
  }

  return <JsonViewer data={interp.data} />;
}

export default function ResultViewer({ data, isError = false }: Props) {
  const [activeTab, setActiveTab] = useState<string>('raw');
  const interpretations = useMemo(() => interpretResult(data), [data]);
  const defaultTab = interpretations[0]?.id ?? 'raw';

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, data]);

  const activeInterpretation = interpretations.find(interp => interp.id === activeTab);

  return (
    <div className="result-viewer">
      {interpretations.length > 0 && (
        <div className="result-viewer-tabs">
          <div className="result-tabs">
            <button
              className={`result-tab${activeTab === 'raw' ? ' active' : ''}`}
              onClick={() => setActiveTab('raw')}
            >Raw</button>
            {interpretations.map(interp => (
              <button
                key={interp.id}
                className={`result-tab${activeTab === interp.id ? ' active' : ''}`}
                onClick={() => setActiveTab(interp.id)}
              >{interp.label}</button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'raw' || !activeInterpretation
        ? <JsonViewer data={data} isError={isError} allowSmartView={false} />
        : renderInterpretation(activeInterpretation)}
    </div>
  );
}