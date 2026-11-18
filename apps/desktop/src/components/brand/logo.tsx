import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import mark from "./logo-mark.png";
import { LOGO_PIECE_TRANSFORM, LOGO_PIECES } from "./logo-pieces";

/** 乾元标志：线稿用作遮罩，颜色跟随文字色（深浅主题自动适配） */
export function LogoMark({ size = 56, className }: { size?: number; className?: string }) {
  const src = typeof mark === "string" ? mark : mark.src;
  const style: CSSProperties = {
    width: size,
    height: size,
    maskImage: `url(${src})`,
    WebkitMaskImage: `url(${src})`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
  return <span aria-hidden className={cn("inline-block bg-current", className)} style={style} />;
}

/** 三块拼件各自的飞入方向（相对标志边长）、纵深与初始翻转，以及先后顺序 */
const PIECES = [
  {
    key: "top",
    dx: -0.5,
    dy: -0.87,
    z: 1.5,
    rotate: "rotateX(50deg) rotateY(-30deg)",
    delay: 0,
    outDelay: 0.16,
  },
  {
    key: "left",
    dx: -0.6,
    dy: 0.8,
    z: 1,
    rotate: "rotateY(55deg) rotateX(20deg)",
    delay: 0.18,
    outDelay: 0.08,
  },
  {
    key: "right",
    dx: 1,
    dy: 0,
    z: 1.8,
    rotate: "rotateY(-50deg) rotateZ(-10deg)",
    delay: 0.36,
    outDelay: 0,
  },
] as const;

/**
 * 欢迎页的动态标志：三块拼件带透视从各自方向嵌入，拼成与 LogoMark 一致的完整标志，之后轻微浮动。
 * `leaving` 时三块按相反顺序沿各自来路飞出并淡去（欢迎页离场，约 0.6 秒）。
 * 颜色跟随文字色；系统开启“减少动态效果”时直接显示拼好的静态标志（见 globals.css `.logo-assemble`）。
 */
export function LogoAssemble({
  size = 56,
  leaving = false,
  className,
}: {
  size?: number;
  leaving?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("logo-assemble", leaving && "logo-assemble-leaving", className)}
      style={{ "--logo-size": `${size}px` } as CSSProperties}
    >
      <span className="logo-assemble-float">
        {PIECES.map((p) => (
          <svg
            key={p.key}
            aria-hidden
            viewBox="0 0 1024 1024"
            className="logo-assemble-piece"
            style={
              {
                "--piece-dx": p.dx,
                "--piece-dy": p.dy,
                "--piece-z": p.z,
                "--piece-rotate": p.rotate,
                animationDelay: `${leaving ? p.outDelay : p.delay}s`,
              } as CSSProperties
            }
          >
            <g transform={LOGO_PIECE_TRANSFORM}>
              <path d={LOGO_PIECES[p.key]} />
            </g>
          </svg>
        ))}
      </span>
    </span>
  );
}
