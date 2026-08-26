/**
 * compressImage.js
 *
 * Shrink a photo in the browser before it is uploaded.
 *
 * A phone camera produces 4–12MB files. Nothing about a cargo photo needs
 * that: it exists so someone can see the state of a box, and 1600px on the
 * long edge shows that perfectly. The saving is enormous — typically 90–95%
 * — and on the mobile connections this system is used over, that is the
 * difference between an upload that finishes and one that times out.
 *
 * Quality is protected in three ways:
 *
 *   1. the image is only ever scaled down, never up
 *   2. the resize happens in one step on a canvas the browser draws with
 *      smoothing enabled, rather than repeated halving
 *   3. JPEG at 0.82 — above the point where artefacts become visible on
 *      photographs, below the point where file size runs away
 *
 * Anything that isn't a raster image, or that is already small, is returned
 * untouched. Better to upload the original than to risk mangling it.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Below this there is nothing worth saving. */
const SKIP_UNDER_BYTES = 300 * 1024;

const loadImage = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });

/**
 * @param {File} file
 * @returns {Promise<{file: File, before: number, after: number, saved: number}>}
 */
export async function compressImage(file) {
  const unchanged = { file, before: file.size, after: file.size, saved: 0 };

  if (!file || !file.type?.startsWith("image/")) return unchanged;
  // GIFs may be animated and SVGs aren't raster — a canvas would flatten
  // one and rasterise the other, both of which lose more than they save.
  if (file.type === "image/gif" || file.type === "image/svg+xml") return unchanged;
  if (file.size < SKIP_UNDER_BYTES) return unchanged;

  try {
    const img = await loadImage(file);
    const { width, height } = img;
    const longest = Math.max(width, height);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // White behind the image: a transparent PNG turned into a JPEG would
    // otherwise get a black background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob) return unchanged;

    // If compression somehow made it bigger — a small, already-optimised
    // image can do this — keep the original.
    if (blob.size >= file.size) return unchanged;

    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    const compressed = new File([blob], name, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });

    return {
      file: compressed,
      before: file.size,
      after: compressed.size,
      saved: Math.round((1 - compressed.size / file.size) * 100),
    };
  } catch {
    // A browser that can't do this is not a reason to block the upload.
    return unchanged;
  }
}

export const humanSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
