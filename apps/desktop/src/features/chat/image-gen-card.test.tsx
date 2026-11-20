import type { ImageGenDetails } from "@primus/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudPoint,
  DISPLAY_EDGE,
  elapsedSeconds,
  flyProgress,
  frameBox,
  ImageGenCard,
  particleGrid,
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
  it("生成中：按张数显示展开的 360×450 生成框、粒子画布，框下是流光文字与计时", () => {
    const { container } = render(
      <ImageGenCard args={{ prompt: "猫", n: 2, intent: "fast" }} details={undefined} running />,
    );
    expect(screen.getAllByText("正在生成图片")).toHaveLength(2);
    expect(screen.getAllByText("已用 0 秒")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "复制图片" })).toBeNull();
    expect(container.querySelectorAll(".imggen-unfold")).toHaveLength(2);
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
    expect(container.querySelectorAll("fieldset")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "生成的图片" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByText("已生成图片")).toBeNull();
  });

  it("多图结果以轮播显示：圆点和箭头切换当前图", async () => {
    const two: ImageGenDetails = {
      ...DONE,
      images: [
        { path: "C:\\data\\a.png", width: 1024, height: 1024 },
        { path: "C:\\data\\b.png", width: 1024, height: 1024 },
      ],
    };
    render(<ImageGenCard args={{ prompt: "猫", n: 2 }} details={two} running={false} />);
    expect(await screen.findByText("1/2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "第 1 张" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "第 2 张" })).toBeTruthy();
    // 第一张时没有“上一张”，有“下一张”
    expect(screen.queryByRole("button", { name: "上一张" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一张" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
  });

  it("计时每秒加一", () => {
    vi.useFakeTimers();
    try {
      render(<ImageGenCard args={{ prompt: "猫", intent: "fast" }} details={undefined} running />);
      expect(screen.getByText("0s")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByText("3s")).toBeTruthy();
      expect(screen.getByText("已用 3 秒")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("带参考图时显示“正在修改图片”", () => {
    render(<ImageGenCard args={{ prompt: "改", images: ["a.png"] }} details={undefined} running />);
    expect(screen.getByText("正在修改图片")).toBeTruthy();
  });

  it("生成中完成：读缩略图后（无画布时跳过粒子成像）直接淡入，出现“已生成图片”与操作行", async () => {
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
    // 框下的“正在生成图片”换成了操作行
    expect(screen.queryByText("正在生成图片")).toBeNull();
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

  it("计时取整秒，不为负", () => {
    expect(elapsedSeconds(0)).toBe(0);
    expect(elapsedSeconds(12_900)).toBe(12);
    expect(elapsedSeconds(-5)).toBe(0);
  });

  it("框按图片比例缩进 360×450 内、不裁切，缺宽高时退回默认框", () => {
    expect(frameBox(1024, 1024)).toEqual({ w: 360, h: 360 });
    expect(frameBox(1536, 1024)).toEqual({ w: 360, h: 240 });
    expect(frameBox(1024, 1536)).toEqual({ w: 300, h: 450 });
    expect(frameBox()).toEqual({ w: 360, h: 450 });
  });

  it("粒子：按 6px 格距铺满框，一格一颗", () => {
    expect(particleGrid(360, 450)).toEqual({ cols: 60, rows: 75 });
    expect(particleGrid(360, 240)).toEqual({ cols: 60, rows: 40 });
    expect(particleGrid(2, 2)).toEqual({ cols: 1, rows: 1 });
  });

  it("粒子云：在云中位置附近小幅晃动", () => {
    for (let i = 0; i < 200; i += 1) {
      const p = { cx: 180, cy: 200, ph: Math.random() * 6.3 };
      const { x, y } = cloudPoint(p, i / 7);
      expect(Math.abs(x - 180)).toBeLessThanOrEqual(16);
      expect(Math.abs(y - 200)).toBeLessThanOrEqual(11);
    }
  });

  it("成像进度：错峰之前为 0，之后单调增加到 1", () => {
    expect(flyProgress(0.2, 0.3)).toBe(0);
    let last = 0;
    for (let t = 0.3; t <= 1.4; t += 0.05) {
      const k = flyProgress(t, 0.3);
      expect(k).toBeGreaterThanOrEqual(last);
      last = k;
    }
    expect(flyProgress(5, 0.3)).toBe(1);
  });
});
