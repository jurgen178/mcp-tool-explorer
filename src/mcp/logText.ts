const MAX_LOG_TEXT_LENGTH = 32 * 1024;

export function clampLogText(text: string, maxLength = MAX_LOG_TEXT_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }

  const headLength = Math.ceil(maxLength * 0.75);
  const tailLength = maxLength - headLength;
  const omittedChars = text.length - maxLength;
  const marker = `\n\n========== TRUNCATED ${omittedChars} CHARS ==========\n\n`;

  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

export { MAX_LOG_TEXT_LENGTH };