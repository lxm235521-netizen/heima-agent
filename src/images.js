/**
 * Server-side image intake: validate the data URL, sniff the real format from
 * magic bytes, and read true pixel dimensions from the container header.
 *
 * Why this matters: dimensions tell the model the framing/aspect of a reference
 * image, which the H3 guide needs for keyframe and storyboard anchors. We also
 * refuse non-images early instead of paying for a failed upstream call.
 */
import { MAX_IMAGES } from "./prompts.js";

export const MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const MAGIC = [
  { mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b.length > 6 && b.slice(0, 3).toString("latin1") === "GIF" },
  {
    mime: "image/webp",
    test: (b) =>
      b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP",
  },
];

export function sniffMime(buf, declared = "") {
  for (const entry of MAGIC) if (entry.test(buf)) return entry.mime;
  return declared && declared.startsWith("image/") ? declared : "";
}

function dimensions(buf, mime) {
  try {
    if (mime === "image/png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buf[offset + 1];
        const size = buf.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding DHT(c4), JPGA(c8) and DAC(cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + size;
      }
    }
    if (mime === "image/webp" && buf.length > 30) {
      const fourCC = buf.slice(12, 16).toString("latin1");
      if (fourCC === "VP8X") {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      if (fourCC === "VP8 ") {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourCC === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* fall through */
  }
  return { width: 0, height: 0 };
}

/**
 * @param {Array<{name?: string, dataUrl: string}>} rawImages
 * @returns {{ images: Array<object>, warnings: string[] }}
 * @throws {Error} on a hard violation (too many images, oversized, not an image)
 */
export function parseImages(rawImages) {
  const list = Array.isArray(rawImages) ? rawImages : [];
  const warnings = [];
  if (list.length > MAX_IMAGES) {
    throw new Error(`最多支持 ${MAX_IMAGES} 张参考图（H3 Ref2VA 规格上限），当前收到 ${list.length} 张。`);
  }

  let total = 0;
  const images = list.map((item, index) => {
    const dataUrl = String(item?.dataUrl ?? "");
    const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new Error(`第 ${index + 1} 张图片不是合法的 data URL。`);
    if (!match[2]) throw new Error(`第 ${index + 1} 张图片必须使用 base64 编码的 data URL。`);

    const declared = match[1] || "";
    const buf = Buffer.from(match[3], "base64");
    if (!buf.length) throw new Error(`第 ${index + 1} 张图片内容为空。`);
    if (buf.length > MAX_BYTES_PER_IMAGE) {
      throw new Error(
        `第 ${index + 1} 张图片 ${(buf.length / 1048576).toFixed(1)}MB，超过单张 ${MAX_BYTES_PER_IMAGE / 1048576}MB 上限，请先压缩。`,
      );
    }
    total += buf.length;

    const mime = sniffMime(buf, declared);
    if (!mime) throw new Error(`第 ${index + 1} 张图片不是 PNG/JPEG/WebP/GIF，无法作为参考图。`);
    if (declared && declared !== mime) {
      warnings.push(`第 ${index + 1} 张图声明为 ${declared}，实际是 ${mime}，已按实际格式处理。`);
    }

    const { width, height } = dimensions(buf, mime);
    if (width && height) {
      const long = Math.max(width, height);
      const short = Math.min(width, height);
      if (short < 256) warnings.push(`第 ${index + 1} 张图分辨率偏低（${width}x${height}），细节可能识别不准。`);
      if (long / short > 3) warnings.push(`第 ${index + 1} 张图比例极端（${width}x${height}），建议裁剪。`);
    }

    return {
      index: index + 1,
      name: String(item?.name ?? `image-${index + 1}`).slice(0, 120),
      mime,
      bytes: buf.length,
      width,
      height,
      // Re-encode so the payload we forward is exactly the bytes we validated.
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    };
  });

  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`图片总大小 ${(total / 1048576).toFixed(1)}MB 超过 ${MAX_TOTAL_BYTES / 1048576}MB 上限。`);
  }
  return { images, warnings };
}
