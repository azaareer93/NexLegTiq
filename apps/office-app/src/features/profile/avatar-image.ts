/** Avatars are sent as a 256 px square JPEG (D-146): small enough for every screen, far under the API's 2 MB. */
export const AVATAR_SIZE = 256;

/**
 * The picked image cropped to its centre square and scaled to AVATAR_SIZE, as a JPEG. The browser decodes it, so a file
 * that is not an image it can read is refused here (null) before anything is sent.
 */
export async function squareAvatar(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9));
}
