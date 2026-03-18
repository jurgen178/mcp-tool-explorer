import type { MessageToExtension } from './types';

interface VsCodeApi {
  postMessage(message: MessageToExtension): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let _api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
  if (!_api) {
    // acquireVsCodeApi is only available inside a VS Code WebView
    if (typeof acquireVsCodeApi !== 'undefined') {
      _api = acquireVsCodeApi();
    } else {
      // Stub for local development outside VS Code
      _api = {
        postMessage: (msg) => console.log('[vscode stub] postMessage', msg),
        getState: () => undefined,
        setState: () => undefined,
      };
    }
  }
  return _api;
}

export function postMessage(message: MessageToExtension): void {
  getApi().postMessage(message);
}
