/**
 * Browser-local file selection filters.
 *
 * These names are operating-system metadata rather than visa materials. Keep
 * the list explicit so adding or removing an entry remains easy to review.
 */
export const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

export function shouldIgnoreSelectedFile(file) {
  return IGNORED_FILE_NAMES.has(file?.name || "");
}

export function filterSelectedFiles(files) {
  return Array.from(files || []).filter((file) => !shouldIgnoreSelectedFile(file));
}
