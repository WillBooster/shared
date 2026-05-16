export function printBufferedOutput(exitCode: number, output: string): void {
  if (!shouldPrintBufferedOutput(exitCode, output)) return;

  const normalizedOutput = normalizeBufferedOutput(output);
  if (normalizedOutput) {
    process.stdout.write(normalizedOutput);
    process.stdout.write('\n');
  }
}

export function shouldPrintBufferedOutput(exitCode: number, output: string): boolean {
  return exitCode !== 0 || hasWarningOutput(output);
}

export function normalizeBufferedOutput(output: string): string {
  return output.trim();
}

function hasWarningOutput(output: string): boolean {
  return /\bwarn(?:ing)?s?\b/i.test(output.replaceAll(/\b(?:0|no) warnings?\b/gi, ''));
}
