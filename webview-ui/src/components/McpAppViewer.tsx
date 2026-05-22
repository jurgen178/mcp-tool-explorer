import { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';

interface CspMeta {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
}

interface Props {
  serverId: string;
  resourceUri: string;
  /** Arguments that were passed to the tool call. */
  toolArgs: Record<string, unknown>;
  /** Raw MCP result content from the tool call. */
  toolResult: unknown;
  /** Structured output (MCP spec 2026-01-26) used by MCP App UIs for rich rendering. */
  toolStructuredContent?: unknown;
}

let reqCounter = 0;
function nextReqId() { return `ui-${Date.now()}-${++reqCounter}`; }

/**
 * Builds an iframe-friendly Content-Security-Policy string from the
 * resource metadata declared by the MCP server.
 */
function buildCsp(csp: CspMeta | undefined): string {
  const connect = csp?.connectDomains?.join(' ') ?? '';
  const resources = csp?.resourceDomains?.join(' ') ?? '';
  const frames = csp?.frameDomains?.join(' ') ?? "'none'";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources}`.trimEnd(),
    `style-src 'self' 'unsafe-inline' ${resources}`.trimEnd(),
    `img-src 'self' data: ${resources}`.trimEnd(),
    `font-src 'self' ${resources}`.trimEnd(),
    `media-src 'self' data: ${resources}`.trimEnd(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

/**
 * Reads VS Code CSS variables from the webview DOM and returns a <style> tag
 * that exposes them as --mcp-* custom properties for MCP App iframes.
 * Also injects light-mode token colour overrides when not in dark theme.
 */
function getThemeStyleTag(): string {
  const cs = getComputedStyle(document.body);
  const get = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  const vars = [
    `--mcp-bg:${get('--vscode-editor-background', dark ? '#0d1117' : '#ffffff')}`,
    `--mcp-fg:${get('--vscode-editor-foreground', dark ? '#e6edf3' : '#24292f')}`,
    `--mcp-bg2:${get('--vscode-sideBar-background', dark ? '#161b22' : '#f6f8fa')}`,
    `--mcp-border:${get('--vscode-panel-border', dark ? '#30363d' : '#d0d7de')}`,
    `--mcp-border2:${get('--vscode-editorWidget-border', dark ? '#21262d' : '#e1e4e8')}`,
    `--mcp-accent:${get('--vscode-focusBorder', dark ? '#388bfd' : '#0969da')}`,
    `--mcp-muted:${get('--vscode-descriptionForeground', dark ? '#8b949e' : '#656d76')}`,
    `--mcp-muted2:${get('--vscode-disabledForeground', dark ? '#484f58' : '#8c959f')}`,
    `--mcp-input-bg:${get('--vscode-input-background', dark ? '#161b22' : '#ffffff')}`,
    `--mcp-input-fg:${get('--vscode-input-foreground', dark ? '#e6edf3' : '#24292f')}`,
    `--mcp-input-border:${get('--vscode-input-border', dark ? '#30363d' : '#d0d7de')}`,
    `--mcp-green:${get('--vscode-gitDecoration-addedResourceForeground', dark ? '#3fb950' : '#1a7f37')}`,
    `--mcp-red:${get('--vscode-errorForeground', dark ? '#f85149' : '#cf222e')}`,
    `--mcp-diff-add:${get('--vscode-diffEditor-insertedLineBackground', dark ? 'rgba(46,160,67,.12)' : 'rgba(26,127,55,.1)')}`,
    `--mcp-diff-rem:${get('--vscode-diffEditor-removedLineBackground', dark ? 'rgba(248,81,73,.12)' : 'rgba(207,34,46,.1)')}`,
    `--mcp-diff-add-hl:${get('--vscode-diffEditor-insertedTextBackground', dark ? 'rgba(46,160,67,.45)' : 'rgba(26,127,55,.35)')}`,
    `--mcp-diff-rem-hl:${get('--vscode-diffEditor-removedTextBackground', dark ? 'rgba(248,81,73,.45)' : 'rgba(207,34,46,.35)')}`,
  ].join(';');
  // Light-mode token badge overrides (the dark solid backgrounds are replaced with pastel variants)
  const lightTokens = dark ? '' :
    '.t-literal{background:rgba(9,105,218,.12);color:#0550ae}' +
    '.t-anchor{background:rgba(130,80,223,.12);color:#6639ba}' +
    '.t-wildcard{background:rgba(207,67,0,.12);color:#bc4c00}' +
    '.t-charClass{background:rgba(26,127,55,.12);color:#1a7f37}' +
    '.t-group{background:rgba(31,136,161,.12);color:#1f7a8c}' +
    '.t-quantifier{background:rgba(191,135,0,.12);color:#744500}' +
    '.t-escape{background:rgba(217,31,112,.12);color:#b22c5e}' +
    '.t-alternation{background:rgba(100,110,120,.12);color:#575e68}' +
    '.decl{color:#0550ae}.expr{color:#1a7f37}.stmt{color:#bc4c00}.lit{color:#6639ba}.nm{color:#744500}.tx{color:#0550ae}' +
    '.children{border-left-color:var(--mcp-border2,#d0d7de)}';
  return `<style>:root{${vars}}${lightTokens}</style>`;
}

/**
 * Only injects a CSP meta tag — no bridge script.
 * The MCP Apps SDK in the iframe sends JSON-RPC 2.0 to window.parent natively.
 * Our webview handleIframeMessage acts as the MCP host.
 */
function prepareHtml(html: string, csp: CspMeta | undefined): string {
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(csp)}">`;
  const themeStyle = getThemeStyleTag();
  const inject = `${cspTag}\n  ${themeStyle}`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1\n  ${inject}`);
  }
  return inject + '\n' + html;
}

export default function McpAppViewer({ serverId, resourceUri, toolArgs, toolResult, toolStructuredContent }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [html, setHtml] = useState<{ content: string; csp: CspMeta | undefined } | undefined>();
  const [iframeHeight, setIframeHeight] = useState(400);
  // Tracks whether the MCP App inside the iframe has completed its initialization
  // handshake. Used to push updated tool data directly on re-runs without waiting
  // for ui/notifications/initialized to fire again.
  const appInitializedRef = useRef(false);
  // Tracks the last tool data sent to the iframe. Compared by reference to avoid
  // duplicate pushes when the parent re-renders without changing tool data.
  const prevToolDataRef = useRef<{ args: unknown; result: unknown; sc: unknown } | null>(null);

  // Fetch the UI resource HTML from the extension
  useEffect(() => {
    const reqId = nextReqId();

    function onMessage(event: MessageEvent) {
      const msg = event.data;
      if (!msg || msg.requestId !== reqId) return;
      if (msg.type === 'uiResourceContent') {
        setHtml({ content: msg.html as string, csp: msg.csp as CspMeta | undefined });
        setStatus('ready');
        window.removeEventListener('message', onMessage);
      } else if (msg.type === 'error') {
        setStatus('error');
        setErrorMsg(msg.message as string);
        window.removeEventListener('message', onMessage);
      }
    }

    window.addEventListener('message', onMessage);
    postMessage({ type: 'fetchUiResource', serverId, uri: resourceUri, requestId: reqId });
    return () => window.removeEventListener('message', onMessage);
  }, [serverId, resourceUri]);

  // Set srcdoc when HTML arrives
  useEffect(() => {
    if (!html) return;
    const iframe = iframeRef.current;
    if (iframe) {
      appInitializedRef.current = false; // iframe reloads → full handshake required again
      prevToolDataRef.current = null;
      iframe.srcdoc = prepareHtml(html.content, html.csp);
    }
  }, [html]);

  // PostMessage bridge: iframe (MCP Apps SDK) ↔ webview ↔ extension
  //
  // The SDK inside the iframe sends JSON-RPC 2.0 to window.parent.
  // We receive those requests here and act as the MCP host:
  //   initialize                    → standard MCP handshake response
  //   notifications/initialized     → ack (no response needed)
  //   ui/initialize                 → respond with hostContext
  //   ui/notifications/initialized  → view is ready; send tool-input + tool-result
  //   tools/call                    → proxy to MCP server via extension
  //   resources/read                → proxy to MCP server via extension
  //   ui/open-link                  → open URL externally
  //   ping                          → respond with {}
  useEffect(() => {
    const inflightListeners = new Set<(e: MessageEvent) => void>();

    function sendToIframe(payload: unknown) {
      iframeRef.current?.contentWindow?.postMessage(payload, '*');
    }

    // If the iframe has already completed the initialization handshake (e.g. the
    // tool was re-run and toolResult changed), push the new data directly without
    // waiting for ui/notifications/initialized to fire again.
    // Guard by reference equality to avoid duplicate pushes when the parent
    // re-renders without actually changing tool data.
    if (appInitializedRef.current) {
      const prev = prevToolDataRef.current;
      if (!prev || prev.args !== toolArgs || prev.result !== toolResult || prev.sc !== toolStructuredContent) {
        prevToolDataRef.current = { args: toolArgs, result: toolResult, sc: toolStructuredContent };
        sendToIframe({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: toolArgs } });
        sendToIframe({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: Array.isArray(toolResult) ? toolResult : [], isError: false, ...(toolStructuredContent !== undefined ? { structuredContent: toolStructuredContent } : {}) } });
      }
    }

    function handleIframeMessage(event: MessageEvent) {
      const msg = event.data as Record<string, unknown>;
      if (!msg || typeof msg !== 'object') return;
      // Only handle MCP JSON-RPC 2.0 messages from the iframe SDK.
      // Extension host messages use { type: '...' } and never have jsonrpc.
      if (msg.jsonrpc !== '2.0') return;

      const method = msg.method as string | undefined;
      const id = msg.id;

      // Standard MCP initialize
      if (method === 'initialize' && id !== undefined) {
        sendToIframe({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2026-01-26',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'mcp-tool-explorer', version: '1.0.0' },
          },
        });
        return;
      }

      // Standard MCP notifications/initialized (ack from view, no reply needed)
      if (method === 'notifications/initialized') return;

      // MCP Apps ui/initialize
      if (method === 'ui/initialize' && id !== undefined) {
        const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
        sendToIframe({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2026-01-26',
            hostCapabilities: { serverTools: {}, serverResources: {}, logging: {} },
            hostInfo: { name: 'mcp-tool-explorer', version: '1.0.0' },
            hostContext: { theme: isDark ? 'dark' : 'light', platform: 'desktop', displayMode: 'inline' },
          },
        });
        return;
      }

      // View signals it is fully initialized → send tool data
      if (method === 'ui/notifications/initialized') {
        appInitializedRef.current = true;
        prevToolDataRef.current = { args: toolArgs, result: toolResult, sc: toolStructuredContent };
        sendToIframe({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: toolArgs } });
        // toolResult is the raw MCP content array; wrap it into the CallToolResult shape the SDK expects.
        // Include structuredContent if the server provided it (MCP spec 2026-01-26).
        sendToIframe({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: Array.isArray(toolResult) ? toolResult : [], isError: false, ...(toolStructuredContent !== undefined ? { structuredContent: toolStructuredContent } : {}) } });
        return;
      }

      // ping
      if (method === 'ping' && id !== undefined) {
        sendToIframe({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      // tools/call → proxy to MCP server
      if (method === 'tools/call' && id !== undefined) {
        const reqId = nextReqId();
        const params = msg.params as Record<string, unknown>;
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;

        function onToolResult(event2: MessageEvent) {
          const m = event2.data;
          if (!m || m.requestId !== reqId) return;
          if (m.type === 'toolResult') {
            sendToIframe({ jsonrpc: '2.0', id, result: { content: m.result, isError: m.isError, ...(m.structuredContent !== undefined ? { structuredContent: m.structuredContent } : {}) } });
          } else if (m.type === 'error') {
            sendToIframe({ jsonrpc: '2.0', id, error: { code: -32000, message: m.message } });
          }
          window.removeEventListener('message', onToolResult);
          inflightListeners.delete(onToolResult);
        }
        window.addEventListener('message', onToolResult);
        inflightListeners.add(onToolResult);
        postMessage({ type: 'callTool', serverId, toolName, args, requestId: reqId });
        return;
      }

      // resources/read → proxy to MCP server
      if (method === 'resources/read' && id !== undefined) {
        const reqId = nextReqId();
        const uri = (msg.params as Record<string, unknown>)?.uri as string;

        function onResourceResult(event2: MessageEvent) {
          const m = event2.data;
          if (!m || m.requestId !== reqId) return;
          if (m.type === 'resourceContent') {
            sendToIframe({ jsonrpc: '2.0', id, result: m.content });
          } else if (m.type === 'error') {
            sendToIframe({ jsonrpc: '2.0', id, error: { code: -32000, message: m.message } });
          }
          window.removeEventListener('message', onResourceResult);
          inflightListeners.delete(onResourceResult);
        }
        window.addEventListener('message', onResourceResult);
        inflightListeners.add(onResourceResult);
        postMessage({ type: 'readResource', serverId, uri, requestId: reqId });
        return;
      }

      // ui/open-link
      if (method === 'ui/open-link' && id !== undefined) {
        const url = (msg.params as Record<string, unknown>)?.url as string;
        if (url) postMessage({ type: 'openExternal', url });
        sendToIframe({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      // ui/notifications/size-changed → resize iframe to avoid inner scrollbar
      if (method === 'ui/notifications/size-changed') {
        const params = msg.params as Record<string, unknown> | undefined;
        const h = params?.height;
        if (typeof h === 'number' && h > 0) setIframeHeight(Math.ceil(h));
        return;
      }
    }

    window.addEventListener('message', handleIframeMessage);
    return () => {
      window.removeEventListener('message', handleIframeMessage);
      for (const l of inflightListeners) window.removeEventListener('message', l);
    };
  }, [serverId, toolArgs, toolResult, toolStructuredContent]);

  if (status === 'error') {
    return <div className="mcp-app-error">Failed to load MCP App: {errorMsg}</div>;
  }

  return (
    <div className="mcp-app-viewer">
      {status === 'loading' && <div className="mcp-app-loading">Loading app…</div>}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        className={`mcp-app-iframe${status === 'loading' ? ' mcp-app-iframe--hidden' : ''}`}
        style={{ height: iframeHeight }}
        title="MCP App"
      />
    </div>
  );
}
