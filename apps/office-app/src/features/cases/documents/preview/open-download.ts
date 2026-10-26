/** Follows a download link: the storage serves an attachment (D-085), so the page stays where it is. */
export function openDownload(url: string): void {
  const link = window.document.createElement('a');
  link.href = url;
  link.rel = 'noopener noreferrer';
  link.click();
}
