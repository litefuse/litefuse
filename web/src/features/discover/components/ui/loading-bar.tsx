// @ts-nocheck
"use client";

export function LoadingBar({ width }: { width?: number }) {
  return (
    <div
      className="h-0.5 animate-[shimmer_1.5s_infinite]"
      style={{
        background:
          "linear-gradient(90deg, transparent 0%, #608DFF 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        width: width ? `${width}%` : "100%",
      }}
    />
  );
}
