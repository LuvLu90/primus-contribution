"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// 能力中心并入设置（ADR 0017）：旧地址跳到 /settings/?group=capabilities
export default function CapabilitiesPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/?group=capabilities");
  }, [router]);
  return null;
}
