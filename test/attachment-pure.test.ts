import { jest } from "@jest/globals";
import type { ChatMessage } from "../app/store/chat";
import { getMessageImages, getMessageTextContent } from "../app/utils";

/**
 * I3-A USER 图片 overlay 纯函数测试(I3-IMG-01..03,设计 M1/M6/M7/INV-IMAGE-01)。
 *
 * 数据双源:same-id 时 Backend fresh 是文本/status 权威,本页 ephemeral overlay
 * 只是 image_url 的唯一来源 —— 直通(引用不变)/ 保图(fresh 为基)/ 无伪占位。
 */

let preserveLocalUserImages: (typeof import("../app/store/chat"))["preserveLocalUserImages"];

beforeAll(async () => {
  ({ preserveLocalUserImages } = await import("../app/store/chat"));
});

const IMG_A = "data:image/png;base64,AAAA";
const IMG_B = "data:image/gif;base64,BBBB";

function msg(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m-1",
    role: "user",
    content: "",
    date: "2026-09-10T00:00:00.000Z",
    ...override,
  } as ChatMessage;
}

function withImages(id: string, text: string, images: string[]): ChatMessage {
  return msg({
    id,
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });
}

describe("I3-A preserveLocalUserImages(M1/M9 纯函数)", () => {
  test("I3-IMG-01 直通:非 USER / 异 id / local 无图 → 原引用返回(零开销)", () => {
    const freshUser = msg({ id: "m-1", content: "来自后端" });
    const freshAssistant = msg({ id: "m-2", role: "assistant", content: "回答" });

    // 异 id
    expect(
      preserveLocalUserImages(freshUser, withImages("m-9", "", [IMG_A])),
    ).toBe(freshUser);
    // local 无图(纯文本)
    expect(preserveLocalUserImages(freshUser, msg({ id: "m-1" }))).toBe(
      freshUser,
    );
    // fresh 非 USER
    expect(
      preserveLocalUserImages(freshAssistant, withImages("m-2", "", [IMG_A])),
    ).toBe(freshAssistant);
    // local 缺失
    expect(preserveLocalUserImages(freshUser, undefined)).toBe(freshUser);
  });

  test("I3-IMG-02 保图:same-id USER + local 有图 → fresh 为基重挂 image_url", () => {
    const fresh = msg({
      id: "m-1",
      content: "后端权威文本",
      position: 7,
      streaming: false,
    });
    const local = withImages("m-1", "本地旧文本", [IMG_A, IMG_B]);

    const merged = preserveLocalUserImages(fresh, local);

    expect(merged).not.toBe(fresh);
    // 文本/字段以 fresh 为基(本地旧文本不得回流)
    expect(merged.position).toBe(7);
    expect(merged.date).toBe(fresh.date);
    expect(getMessageTextContent(merged)).toBe("后端权威文本");
    // 图片按 local 顺序重挂
    expect(getMessageImages(merged)).toEqual([IMG_A, IMG_B]);
    expect(merged.content).toEqual([
      { type: "text", text: "后端权威文本" },
      { type: "image_url", image_url: { url: IMG_A } },
      { type: "image_url", image_url: { url: IMG_B } },
    ]);
  });

  test("I3-IMG-02A fresh 纯图 content 为空 → 不补空 text part,不吞图", () => {
    const fresh = msg({ id: "m-1", content: "" });
    const local = withImages("m-1", "", [IMG_A]);

    const merged = preserveLocalUserImages(fresh, local);

    expect(merged.content).toEqual([
      { type: "image_url", image_url: { url: IMG_A } },
    ]);
    expect(getMessageTextContent(merged)).toBe("");
    expect(getMessageImages(merged)).toEqual([IMG_A]);
  });

  test("I3-IMG-03 无伪占位:文本与图片严格同源,不写「[图片]」等注解", () => {
    const soloImages = preserveLocalUserImages(
      msg({ id: "m-1", content: "" }),
      withImages("m-1", "", [IMG_A]),
    );
    const serialized = JSON.stringify(soloImages.content);
    expect(serialized).not.toContain("图片");
    expect(serialized).not.toContain("[image");
    expect((soloImages.content as unknown[]).length).toBe(1);

    const withText = preserveLocalUserImages(
      msg({ id: "m-1", content: "" }),
      withImages("m-1", "", [IMG_A, IMG_B]),
    );
    expect((withText.content as unknown[]).length).toBe(2);
  });

  test("I3-IMG-03A 幂等:连续两次 overlay 结果稳定(不累积重复图片)", () => {
    const fresh = msg({ id: "m-1", content: "t" });
    const local = withImages("m-1", "t", [IMG_A]);

    const once = preserveLocalUserImages(fresh, local);
    const twice = preserveLocalUserImages(once, local);

    expect(twice).not.toBe(once);
    expect(getMessageImages(twice)).toEqual([IMG_A]);
    expect(getMessageTextContent(twice)).toBe("t");
  });
});
