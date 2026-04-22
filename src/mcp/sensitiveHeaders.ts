/**
 * Header names that contain credentials and must be redacted in logs.
 * Shared between LoggingFetch and McpClientManager to avoid duplication.
 */
export const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);
