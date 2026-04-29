export function shouldPrintBufferedOutput(exitCode: number, output: string): boolean {
  return exitCode !== 0 || hasWarningOutput(removeNoColorWarning(output));
}

export function normalizeBufferedOutput(output: string): string {
  return removeNoColorWarning(output).trim();
}

export function printBufferedOutput(exitCode: number, output: string): void {
  if (!shouldPrintBufferedOutput(exitCode, output)) return;

  const normalizedOutput = normalizeBufferedOutput(output);
  if (normalizedOutput) {
    process.stdout.write(normalizedOutput);
    process.stdout.write('\n');
  }
}

function hasWarningOutput(output: string): boolean {
  return /\bwarn(?:ing)?s?\b/i.test(output.replaceAll(/\b(?:0|no) warnings?\b/gi, ''));
}

function removeNoColorWarning(output: string): string {
  return output.replaceAll(
    /\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n?/g,
    ''
  );
}
