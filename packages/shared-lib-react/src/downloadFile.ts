/**
 * Makes the browser save `data` as a file named `fileName`. Pass encoded bytes as `data` for a non-UTF-8 file, e.g. a
 * Shift_JIS CSV for Excel.
 */
export function downloadFile(data: BlobPart, fileName: string, mimeType = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoking right after `click()` can cancel the download in some browsers, so the URL is released later, as
  // FileSaver.js does with the same 40-second delay.
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}
