import { useState } from "react";

type ProductImageProps = {
  src: string;
  alt: string;
  fallbackLabel: string;
  className?: string;
};

/** Shows a clear placeholder when a remote product image cannot be loaded. */
export function ProductImage({ src, alt, fallbackLabel, className }: ProductImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <span className="product-image-fallback" role="img" aria-label={failed ? `${alt}加载失败` : fallbackLabel}>{failed ? "加载失败" : fallbackLabel}</span>;
  }

  return <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
