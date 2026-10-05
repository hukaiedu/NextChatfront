import React from "react";
import type { ImageProps } from "next/image";

// jsdom renders image semantics; Next's server/image optimization is covered by build and Browser gates.
export default function NextImageMock({
  src, alt, fill, priority, placeholder, blurDataURL, loader, unoptimized,
  quality, onLoadingComplete, ...props
}: ImageProps) {
  const resolvedSrc = typeof src === "string" ? src : "default" in src ? src.default.src : src.src;
  return <img {...props} src={resolvedSrc} alt={alt} />;
}
