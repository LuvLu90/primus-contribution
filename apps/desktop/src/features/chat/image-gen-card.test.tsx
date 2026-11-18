import type { ImageGenDetails } from "@primus/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aspectOf, ImageGenCard } from "./image-gen-card";

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

describe("图片生成卡片", () => {
  it("生成中按尺寸与张数显示占位", () => {
    const { container } = render(
      <ImageGenCard args={{ prompt: "猫", size: "1536x1024", n: 2 }} details={undefined} running />,
    );
    expect(screen.getByText("正在生成图片…")).toBeTruthy();
    expect(container.querySelectorAll(".aspect-\\[3\\/2\\]")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "生成的图片" }).getAttribute("aria-busy")).toBe(
      "true",
    );
  });

  it("带参考图时显示“正在修改图片”", () => {
    render(<ImageGenCard args={{ prompt: "改", images: ["a.png"] }} details={undefined} running />);
    expect(screen.getByText("正在修改图片…")).toBeTruthy();
  });

  it("完成后读取并显示图片，点开大图，保存走 image_save", async () => {
    platform.imageSave.mockResolvedValue("C:\\Users\\me\\a.png");
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    const img = await screen.findByAltText("生成的图片：一只橘猫");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(platform.attachmentImage).toHaveBeenCalledWith(DONE.images[0]?.path, 2048);

    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "保存图片" })[0] as HTMLElement);
    await waitFor(() => expect(platform.imageSave).toHaveBeenCalledWith(DONE.images[0]?.path));
    expect((await screen.findAllByText("已保存")).length).toBeGreaterThan(0);
  });

  it("保存失败时显示原因", async () => {
    platform.imageSave.mockRejectedValueOnce(new Error("图片已不存在"));
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await screen.findByAltText("生成的图片：一只橘猫");
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    expect(await screen.findByText("保存失败：图片已不存在")).toBeTruthy();
  });

  it("大图里保存失败时在大图内显示原因", async () => {
    platform.imageSave.mockRejectedValueOnce(new Error("磁盘已满"));
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await screen.findByAltText("生成的图片：一只橘猫");
    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存图片" }));
    expect(await within(dialog).findByText("保存失败：磁盘已满")).toBeTruthy();
  });

  it("取消保存不提示", async () => {
    platform.imageSave.mockResolvedValueOnce(null);
    render(<ImageGenCard args={{ prompt: "猫" }} details={DONE} running={false} />);
    await screen.findByAltText("生成的图片：一只橘猫");
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    await waitFor(() => expect(platform.imageSave).toHaveBeenCalled());
    expect(screen.queryByText("已保存")).toBeNull();
    expect(screen.queryByText(/保存失败/)).toBeNull();
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

  it("尺寸映射到占位比例", () => {
    expect(aspectOf("1536x1024")).toBe("aspect-[3/2]");
    expect(aspectOf("1024x1536")).toBe("aspect-[2/3]");
    expect(aspectOf("auto")).toBe("aspect-square");
  });
});
