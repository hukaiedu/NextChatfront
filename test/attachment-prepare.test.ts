import { jest } from "@jest/globals";
import {
  ATTACHMENT_MAX_FINAL_BYTES,
  ATTACHMENT_PASSTHROUGH_MAX_BYTES,
  AttachmentPrepareError,
  decodedBytesOf,
  prepareAttachment,
} from "../app/utils/attachment";

/**
 * I3-A 本地准备管线纯函数测试(I3-FILE-01..08,设计 R08/R10/R11/R12/F9)。
 *
 * jsdom 不实现 decode 与 canvas,故在此层伪造 `Image` / `HTMLCanvasElement`
 * 的 2d 能力;所有断言只依赖 attachment.ts 对外契约(前缀、mimeType、name、
 * bytes、canvas 调用序)。
 */

// ---- canvas / Image 伪实现 ----

type CanvasOp = { op: string; args: unknown[] };

const canvasOps: CanvasOp[] = [];
let toDataUrlCalls: { width: number; height: number; quality?: number }[] = [];
/** toDataURL 返回的 JPEG 的 decoded bytes(tests 通过它控制收敛迭代次数) */
let canvasOutputBytes = 300_000;
let nextImageSize = { width: 1200, height: 900 };
let failNextImageDecode = false;

function jpegDataUrlOf(bytes: number): string {
  // base64 长度取 4 的倍数:decoded = length / 4 * 3
  const length = Math.ceil(bytes / 3) * 4;
  return `data:image/jpeg;base64,${"A".repeat(length)}`;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 0;
  height = 0;
  #src = "";

  set src(value: string) {
    this.#src = value;
    this.width = nextImageSize.width;
    this.height = nextImageSize.height;
    queueMicrotask(() => {
      if (failNextImageDecode) {
        failNextImageDecode = false;
        this.onerror?.();
        return;
      }
      this.onload?.();
    });
  }

  get src() {
    return this.#src;
  }
}

beforeAll(() => {
  (globalThis as any).Image = FakeImage as unknown as typeof Image;

  const ctxStub = () => {
    const ctx: any = {
      _fillStyle: "",
      fillRect: (...args: unknown[]) => canvasOps.push({ op: "fillRect", args }),
      drawImage: (...args: unknown[]) => canvasOps.push({ op: "drawImage", args }),
    };
    Object.defineProperty(ctx, "fillStyle", {
      get() {
        return this._fillStyle;
      },
      set(value: string) {
        this._fillStyle = value;
        canvasOps.push({ op: "fillStyle", args: [value] });
      },
    });
    return ctx;
  };
  (HTMLCanvasElement.prototype as any).getContext = function () {
    return ctxStub();
  };
  (HTMLCanvasElement.prototype as any).toDataURL = function (
    type?: string,
    quality?: number,
  ) {
    toDataUrlCalls.push({
      width: this.width,
      height: this.height,
      quality,
    });
    expect(type).toBe("image/jpeg");
    return jpegDataUrlOf(canvasOutputBytes);
  };
});

beforeEach(() => {
  canvasOps.length = 0;
  toDataUrlCalls = [];
  canvasOutputBytes = 300_000;
  nextImageSize = { width: 1200, height: 900 };
  failNextImageDecode = false;
});

/** 真实内容 + 伪造 size(避免为 6MB 用例分配 6MB 内存) */
function fileOf(name: string, type: string, size: number, content = "hello"): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const KIB = 1024;

describe("I3-A attachment.ts(本地准备管线)", () => {
  test("I3-FILE-01 白名单内 ≤512KB 原样透传(保 mime 前缀,不碰 canvas)", async () => {
    const file = fileOf("small.png", "image/png", 200 * KIB);
    const image = await prepareAttachment(file);

    expect(image.mimeType).toBe("image/png");
    expect(image.name).toBe("small.png");
    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(image.bytes).toBe(decodedBytesOf(image.dataUrl));
    expect(image.id).toBeTruthy();
    // 透传不压缩:canvas / Image 均未被使用
    expect(toDataUrlCalls).toEqual([]);
    expect(canvasOps).toEqual([]);
  });

  test("I3-FILE-02 >512KB 走压缩分支 → 白底 JPEG + bytes 用 decoded 换算", async () => {
    canvasOutputBytes = 321_000;
    const file = fileOf("big.png", "image/png", 900 * KIB);
    const image = await prepareAttachment(file);

    expect(image.mimeType).toBe("image/jpeg");
    expect(image.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(image.bytes).toBe(decodedBytesOf(image.dataUrl));
    expect(image.bytes).toBeGreaterThanOrEqual(canvasOutputBytes);
    expect(image.bytes).toBeLessThanOrEqual(ATTACHMENT_MAX_FINAL_BYTES);
    // 首次即收敛:只压一轮,quality 从 0.9 起
    expect(toDataUrlCalls).toHaveLength(1);
    expect(toDataUrlCalls[0].quality).toBeCloseTo(0.9, 5);
    expect(toDataUrlCalls[0].width).toBe(1200);
    expect(toDataUrlCalls[0].height).toBe(900);
  });

  test("I3-FILE-03 源 6MB JPEG 不设前置拒绝,压缩后正常接受(F1)", async () => {
    canvasOutputBytes = 400_000;
    const file = fileOf("huge.jpg", "image/jpeg", 6 * 1024 * KIB);
    const image = await prepareAttachment(file);

    expect(image.mimeType).toBe("image/jpeg");
    expect(image.bytes).toBeLessThanOrEqual(ATTACHMENT_MAX_FINAL_BYTES);
    expect(toDataUrlCalls).toHaveLength(1);
  });

  test("I3-FILE-04 GIF(512KB~5MB)原样透传保动画,永不进 canvas(F2/R11)", async () => {
    const file = fileOf("anim.gif", "image/gif", 1 * 1024 * KIB);
    const image = await prepareAttachment(file);

    expect(image.mimeType).toBe("image/gif");
    expect(image.name).toBe("anim.gif");
    expect(image.dataUrl.startsWith("data:image/gif;base64,")).toBe(true);
    expect(image.bytes).toBe(decodedBytesOf(image.dataUrl));
    expect(toDataUrlCalls).toEqual([]);
    expect(canvasOps).toEqual([]);
  });

  test("I3-FILE-04A GIF >5MB 本地拒绝(ImageTooLarge)", async () => {
    const file = fileOf("huge.gif", "image/gif", 6 * 1024 * KIB);
    await expect(prepareAttachment(file)).rejects.toMatchObject({
      name: "AttachmentPrepareError",
      reason: "ImageTooLarge",
    });
    expect(toDataUrlCalls).toEqual([]);
  });

  test("I3-FILE-05 压缩分支 name → foo.jpg,passthrough 保留原名(F9)", async () => {
    const compressed = await prepareAttachment(
      fileOf("foo.png", "image/png", 900 * KIB),
    );
    expect(compressed.name).toBe("foo.jpg");

    const noExt = await prepareAttachment(
      fileOf("foo", "image/png", 900 * KIB),
    );
    expect(noExt.name).toBe("foo.jpg");

    const dotted = await prepareAttachment(
      fileOf("a.b.c.webp", "image/webp", 900 * KIB),
    );
    expect(dotted.name).toBe("a.b.c.jpg");

    const passthrough = await prepareAttachment(
      fileOf("keep.webp", "image/webp", 100 * KIB),
    );
    expect(passthrough.name).toBe("keep.webp");
    expect(passthrough.mimeType).toBe("image/webp");
  });

  test("I3-FILE-06 非白名单 / 空 MIME 一律 ImageTypeUnsupported", async () => {
    await expect(
      prepareAttachment(fileOf("x.svg", "image/svg+xml", 10)),
    ).rejects.toMatchObject({ reason: "ImageTypeUnsupported" });
    await expect(
      prepareAttachment(fileOf("x.heic", "image/heic", 10)),
    ).rejects.toMatchObject({ reason: "ImageTypeUnsupported" });
    await expect(prepareAttachment(fileOf("x.bin", "", 10))).rejects.toMatchObject(
      { reason: "ImageTypeUnsupported" },
    );
    await expect(
      prepareAttachment(fileOf("x.png", "IMAGE/GIF", 10 * KIB)),
    ).resolves.toMatchObject({ mimeType: "image/gif" });
  });

  test("I3-FILE-07 允许重复图片(不做内容/dataUrl 去重,F8)", async () => {
    const first = await prepareAttachment(
      fileOf("dup.png", "image/png", 10 * KIB),
    );
    const second = await prepareAttachment(
      fileOf("dup.png", "image/png", 10 * KIB),
    );

    expect(second.dataUrl).toBe(first.dataUrl);
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(first.name);
  });

  test("I3-FILE-08 透明 PNG 压缩先 fillRect #fff 再 drawImage(白底,R12)", async () => {
    const file = fileOf("transparent.png", "image/png", 1 * 1024 * KIB);
    await prepareAttachment(file);

    const fillStyleIndex = canvasOps.findIndex((c) => c.op === "fillStyle");
    const fillRectIndex = canvasOps.findIndex((c) => c.op === "fillRect");
    const drawImageIndex = canvasOps.findIndex((c) => c.op === "drawImage");

    expect(fillStyleIndex).toBeGreaterThanOrEqual(0);
    expect(fillStyleIndex).toBeLessThan(fillRectIndex);
    expect(fillRectIndex).toBeLessThan(drawImageIndex);
    expect(canvasOps[fillStyleIndex].args).toEqual(["#fff"]);
    expect(canvasOps[fillRectIndex].args).toEqual([0, 0, 1200, 900]);
  });

  test("I3-FILE-08A 未收敛时先降 quality 再缩尺寸(几何收敛)", async () => {
    // 前 6 轮输出均超 5MiB(质量阶梯走完)→ 第 7 轮开始缩尺寸后收敛
    let round = 0;
    (HTMLCanvasElement.prototype as any).toDataURL = function (
      type?: string,
      quality?: number,
    ) {
      toDataUrlCalls.push({ width: this.width, height: this.height, quality });
      round += 1;
      return jpegDataUrlOf(round <= 6 ? 6 * 1024 * 1024 : 100_000);
    };
    try {
      const image = await prepareAttachment(
        fileOf("tough.jpg", "image/jpeg", 8 * 1024 * KIB),
      );
      expect(image.bytes).toBeLessThanOrEqual(ATTACHMENT_MAX_FINAL_BYTES);
      expect(toDataUrlCalls).toHaveLength(7);

      const widths = toDataUrlCalls.map((c) => c.width);
      const qualities = toDataUrlCalls.map((c) => c.quality as number);
      // 起点 0.9;同尺寸阶段质量严格单调下降(先牺牲质量)
      expect(qualities[0]).toBeCloseTo(0.9, 5);
      expect(qualities[qualities.length - 2]).toBeLessThanOrEqual(0.5);
      for (let i = 1; i < toDataUrlCalls.length; i++) {
        if (widths[i] === widths[i - 1]) {
          expect(qualities[i]).toBeLessThan(qualities[i - 1]);
        } else {
          // 缩尺寸的那一轮质量不再下降(后牺牲尺寸)
          expect(qualities[i]).toBeCloseTo(qualities[i - 1], 5);
        }
      }
      expect(widths[widths.length - 1]).toBeLessThan(1200);
      expect(widths[widths.length - 1]).toBeCloseTo(1200 * 0.9, 5);
    } finally {
      (HTMLCanvasElement.prototype as any).toDataURL = function (
        type?: string,
        quality?: number,
      ) {
        toDataUrlCalls.push({ width: this.width, height: this.height, quality });
        return jpegDataUrlOf(canvasOutputBytes);
      };
    }
  });

  test("I3-FILE-08B 解码失败 → ImageReadFailed(单张拒绝,失败路径)", async () => {
    failNextImageDecode = true;
    await expect(
      prepareAttachment(fileOf("broken.png", "image/png", 900 * KIB)),
    ).rejects.toBeInstanceOf(AttachmentPrepareError);
    await expect(
      prepareAttachment(fileOf("broken2.png", "image/png", 900 * KIB)),
    ).resolves.toMatchObject({ mimeType: "image/jpeg" });
  });

  test("I3-FILE-00 常量口径:512KiB 门槛 / 5MiB 单张 / decodedBytesOf 换算", () => {
    expect(ATTACHMENT_PASSTHROUGH_MAX_BYTES).toBe(512 * 1024);
    expect(ATTACHMENT_MAX_FINAL_BYTES).toBe(5 * 1024 * 1024);
    expect(decodedBytesOf("data:image/png;base64,AAAA")).toBe(3);
    expect(decodedBytesOf("data:image/png;base64,AAA=")).toBe(2);
    expect(decodedBytesOf("data:image/png;base64,AA==")).toBe(1);
    expect(decodedBytesOf("not-a-data-url")).toBe(0);
  });
});
