import { nanoid } from "nanoid";

/**
 * I3:聊天附件的前端准备管线(纯浏览器内存,不落盘、不上传独立端点)。
 * 限额一律以 final decoded bytes 为准(R13);dataUrl.length 只允许留在
 * 压缩算法内部,不得作为业务限额传播(F3)。
 */

/** PNG/JPEG/WebP 源 ≤512KiB 原样透传,不进 canvas */
export const ATTACHMENT_PASSTHROUGH_MAX_BYTES = 512 * 1024;
/** 单张 final decoded ≤5MiB(后端 final 附件限额一致) */
export const ATTACHMENT_MAX_FINAL_BYTES = 5 * 1024 * 1024;
/** 整批 final decoded 总量 ≤10MiB */
export const ATTACHMENT_TOTAL_MAX_FINAL_BYTES = 10 * 1024 * 1024;
/** 单次发送最多 4 张 */
export const ATTACHMENT_MAX_COUNT = 4;
/** GIF 无压缩门槛:≤5MiB 原样透传保动画,>5MiB 本地拒绝(R11) */
export const ATTACHMENT_GIF_MAX_BYTES = 5 * 1024 * 1024;

export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export type AttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface PendingImage {
  id: string;
  name: string;
  mimeType: AttachmentMimeType;
  dataUrl: string;
  bytes: number;
}

export type AttachmentPrepareErrorReason =
  | "ImageTooLarge"
  | "ImageTypeUnsupported"
  | "ImageReadFailed";

export class AttachmentPrepareError extends Error {
  constructor(readonly reason: AttachmentPrepareErrorReason) {
    super(reason);
    this.name = "AttachmentPrepareError";
  }
}

const MIME_WHITELIST: AttachmentMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** base64 部分的 decoded byte 数;非法/缺失 data 时返回 0 */
export function decodedBytesOf(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return 0;
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 白底 JPEG 压缩(方案 A,I3 自持;共享 compressImage 不得改动,F10):
 * 思路与其一致 —— 先降 quality(0.9 起步,≥0.5),再缩尺寸(×0.9);
 * 差异:fillRect #fff 先于 drawImage(透明 PNG 压成白底而非黑底),
 * 收敛判据用 final decoded bytes 而非 dataUrl.length。
 */
export function compressChatImage(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new AttachmentPrepareError("ImageReadFailed"));
    reader.onload = (readerEvent) => {
      const image = new Image();
      image.onerror = () =>
        reject(new AttachmentPrepareError("ImageReadFailed"));
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new AttachmentPrepareError("ImageReadFailed"));
          return;
        }
        let width = image.width;
        let height = image.height;
        let quality = 0.9;
        let dataUrl = "";
        do {
          canvas.width = width;
          canvas.height = height;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);
          dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (decodedBytesOf(dataUrl) <= ATTACHMENT_MAX_FINAL_BYTES) break;
          if (quality > 0.5) {
            quality -= 0.1;
          } else {
            width *= 0.9;
            height *= 0.9;
          }
        } while (decodedBytesOf(dataUrl) > ATTACHMENT_MAX_FINAL_BYTES);
        resolve(dataUrl);
      };
      image.src = String(readerEvent.target?.result ?? "");
    };
    reader.readAsDataURL(file);
  });
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new AttachmentPrepareError("ImageReadFailed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function assertWhitelistedDataUrl(dataUrl: string): void {
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) {
    throw new AttachmentPrepareError("ImageTypeUnsupported");
  }
}

/** 压缩输出恒为 JPEG:basename 去原扩展 + .jpg(F9) */
function toCompressedName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.jpg`;
}

/**
 * 单张图片准备:
 * - MIME 白名单(png/jpeg/webp/gif)双层校验的第二层;空 MIME/白名单外拒绝;
 * - GIF ≤5MiB 原样 dataURL(保动画,永不进 canvas),>5MiB 本地拒绝;
 * - 其余 ≤512KiB 原样透传;>512KiB → compressChatImage 白底 JPEG,
 *   再按 final decoded ≤5MiB 验收 —— 源文件大小不设前置拒绝(F1)。
 * 失败抛 AttachmentPrepareError,由调用方按 reason 提示;单张失败不影响批次。
 */
export async function prepareAttachment(file: File): Promise<PendingImage> {
  const mimeType = file.type.toLowerCase();
  if (!MIME_WHITELIST.includes(mimeType as AttachmentMimeType)) {
    throw new AttachmentPrepareError("ImageTypeUnsupported");
  }

  if (mimeType === "image/gif") {
    if (file.size > ATTACHMENT_GIF_MAX_BYTES) {
      throw new AttachmentPrepareError("ImageTooLarge");
    }
    const dataUrl = await readAsDataURL(file);
    assertWhitelistedDataUrl(dataUrl);
    return {
      id: nanoid(),
      name: file.name,
      mimeType: "image/gif",
      dataUrl,
      bytes: decodedBytesOf(dataUrl),
    };
  }

  if (file.size <= ATTACHMENT_PASSTHROUGH_MAX_BYTES) {
    const dataUrl = await readAsDataURL(file);
    assertWhitelistedDataUrl(dataUrl);
    return {
      id: nanoid(),
      name: file.name,
      mimeType: mimeType as AttachmentMimeType,
      dataUrl,
      bytes: decodedBytesOf(dataUrl),
    };
  }

  const dataUrl = await compressChatImage(file);
  assertWhitelistedDataUrl(dataUrl);
  const bytes = decodedBytesOf(dataUrl);
  if (bytes > ATTACHMENT_MAX_FINAL_BYTES) {
    throw new AttachmentPrepareError("ImageTooLarge");
  }
  return {
    id: nanoid(),
    name: toCompressedName(file.name),
    mimeType: "image/jpeg",
    dataUrl,
    bytes,
  };
}
