import type { ImageGenDetails } from "@primus/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_EDGE,
  ImageGenCard,
  remainingSeconds,
  rippleAt,
  TILE_EDGE,
} from "./image-gen-card";

const platform = {
  attachmentImage: vi.fn(),
  imageSave: vi.fn(),
};
vi.mock("@/lib/platform", () => ({ getPlatform: async () => platform }));

const DONE: ImageGenDetails = {
  status: "done",
  prompt: "一只橘猫",
  intent: "default",
  size: "1024x1024",
  model: "gpt-image-2.6",
  images: [{ path: "C:\\data\\users\\S-1\\images\\s\\c-1-1.png", width: 1024, height: 1024 }],
};

beforeEach(() => {
  platform.attachmentImage.mockReset();
  platform.imageSave.mockReset();
  platform.attachmentImage.mockResolvedValue({
    mimeType: "image/png",
    data: "AAAA",
    thumb: "",
    width: 1024,
    height: 1024,
  });
});

async function shownImage() {
  const img = await screen.findByAltText("生成的图片：一只橘猫");
  fireEvent.load(img);
  return img;
}

describe("图片生成卡片", () => {
  it("生成中：按张数显示展开的 200×250 生成框、波纹画布、流光文字与翻页倒计时", () => {
    const { container } = render(
      <ImageGenCard args={{ prompt: "猫", n: 2, intent: "fast" }} details={undefined} running />,
    );
    expect(screen.getAllByText("正在生成图片")).toHaveLength(2);
    expect(screen.getAllByText("剩余 30 秒")).toHaveLength(2);
    expect(container.querySelectorAll(".imggen-unfold")).toHaveLength(2);
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
    expect(container.querySelectorAll(".h-\\[250px\\].w-\\[200px\\]")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "生成的图片" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByText("已生成图片")).toBeNull();
  });

  it("倒计时每秒翻页", () => {
    vi.useFakeTimers();
    try {
      render(<ImageGenCard args={{ prompt: "猫", intent: "fast" }} details={undefined} running />);
      expect(screen.getByText("剩余 30 秒")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByText("剩余 27 秒")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("带参考图时显示“正在修改图片”", () => {
    render(<ImageGenCard args={{ prompt: "改", images: ["a.png"] }} details={undefined} running />);
    expect(screen.getByText("正在修改图片")).toBeTruthy();
  });

  it("生成中完成：读缩略图后以径向遮罩揭示，出现“已生成图片”与操作行", async () => {
    const { rerender, container } = render(
      <ImageGenCard args={{ prompt: "一只橘猫" }} details={undefined} running />,
    );
    rerender(<ImageGenCard args={{ prompt: "一只橘猫" }} details={DONE} running={false} />);
    const img = await shownImage();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(platform.attachmentImage).toHaveBeenCalledWith(DONE.images[0]?.path, TILE_EDGE);
    expect(screen.getByText("已生成图片")).toBeTruthy();
    const reveal = container.querySelector(".imggen-reveal");
    await waitFor(() => expect(reveal?.hasAttribute("data-shown")).toBe(true));
    expect(screen.getByRole("button", { name: "复制图片" })).toBeTruthy();
  });

  it("历史消息里直接显示，不展开、不揭示", async () => {
    const { container } = render(
      <ImageGenCard args={{ prompt: "一只橘猫" }} details={DONE} running={false} />,
    );
    await shownImage();
    expect(container.querySelector(".imggen-unfold")).toBeNull();
    expect(container.querySelector(".imggen-reveal")).toBeNull();
  });

  it("点开大图才读原图；保存走 image_save，结果在框内提示", async () => {
    platform.imageSave.mockResolvedValue("C:\\Users\\me\\a.png");
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await shownImage();
    expect(platform.attachmentImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: "查看大图" })[0] as HTMLElement);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(platform.attachmentImage).toHaveBeenLastCalledWith(DONE.images[0]?.path, DISPLAY_EDGE);

    fireEvent.click(screen.getAllByRole("button", { name: "保存图片" })[0] as HTMLElement);
    await waitFor(() => expect(platform.imageSave).toHaveBeenCalledWith(DONE.images[0]?.path));
    expect((await screen.findAllByText("已保存")).length).toBeGreaterThan(0);
  });

  it("保存失败时显示原因；取消保存不提示", async () => {
    platform.imageSave.mockRejectedValueOnce(new Error("图片已不存在"));
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await shownImage();
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    expect(await screen.findByText("保存失败：图片已不存在")).toBeTruthy();

    platform.imageSave.mockResolvedValueOnce(null);
    await waitFor(() => expect(screen.queryByText(/保存失败/)).toBeNull(), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    await waitFor(() => expect(platform.imageSave).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("大图里保存失败时在大图内显示原因", async () => {
    platform.imageSave.mockRejectedValueOnce(new Error("磁盘已满"));
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await shownImage();
    fireEvent.click(screen.getAllByRole("button", { name: "查看大图" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存图片" }));
    expect(await within(dialog).findByText("保存失败：磁盘已满")).toBeTruthy();
  });

  it("图片文件被删除时显示“图片已不存在”", async () => {
    platform.attachmentImage.mockRejectedValue(new Error("无法读取文件"));
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    expect(await screen.findByText("图片已不存在")).toBeTruthy();
  });

  it("失败与停止只显示一行说明", () => {
    const { rerender } = render(
      <ImageGenCard
        args={{ prompt: "猫" }}
        details={{ ...DONE, status: "failed", images: [], error: "无法连接图片服务" }}
        running={false}
      />,
    );
    expect(screen.getByText("图片生成失败：无法连接图片服务")).toBeTruthy();
    rerender(<ImageGenCard args={{ prompt: "猫" }} details={undefined} running={false} />);
    expect(screen.getByText("已停止生成图片")).toBeTruthy();
  });

  it("倒计时按意图估计，改图多 15 秒，到 0 后不再减少", () => {
    expect(remainingSeconds("quality", false, 0)).toBe(60);
    expect(remainingSeconds("default", true, 10_000)).toBe(50);
    expect(remainingSeconds("fast", false, 99_000)).toBe(0);
    expect(remainingSeconds("weird", false, 0)).toBe(45);
  });

  it("波纹：亮环随时间从中心向外扩散，强度不超过 1", () => {
    // 0.5 秒时第一圈在半径约 0.19 处，0.9 秒时已扩到约 0.35
    expect(rippleAt(0.5, 0.597, 0.5, 1)).toBeGreaterThan(0.8);
    expect(rippleAt(0.5, 0.597, 0.9, 1)).toBeLessThan(0.2);
    expect(rippleAt(0.5, 0.675, 0.9, 1)).toBeGreaterThan(0.8);
    for (let i = 0; i < 50; i += 1)
      expect(rippleAt(Math.random(), Math.random(), i / 10, 0.8)).toBeLessThanOrEqual(1);
  });
});
