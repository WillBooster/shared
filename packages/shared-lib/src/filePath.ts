/**
 * Returns the lower-cased extension of the last path segment without the dot, or an empty string when the segment
 * has none. As with `path.extname`, a leading dot (e.g. `.gitignore`) does not start an extension.
 */
export function getFileExtension(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex > filePath.lastIndexOf('/') + 1 ? filePath.slice(dotIndex + 1).toLowerCase() : '';
}
