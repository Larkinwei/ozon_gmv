import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PackageOpen, X } from "lucide-react";

interface OrderImagePreviewProps {
  src: string | null;
  alt: string;
  fallbackLabel: string;
  width: number;
  height: number;
  className: string;
  placeholderClassName?: string;
  objectFit?: "cover" | "contain";
}

interface PreviewPosition {
  top: number;
  left: number;
}

/** Renders an accessible thumbnail with hover preview and a touch-friendly full-size viewer. */
export function OrderImagePreview({
  src,
  alt,
  fallbackLabel,
  width,
  height,
  className,
  placeholderClassName,
  objectFit = "contain",
}: OrderImagePreviewProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [previewPosition, setPreviewPosition] = useState<PreviewPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const suppressFocusPreviewRef = useRef(false);
  const usableSrc = src && !failed ? src : null;

  const showPreview = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const size = 176;
    const gap = 8;
    const left = rect.right + gap + size <= window.innerWidth
      ? rect.right + gap
      : Math.max(8, rect.left - gap - size);
    setPreviewPosition({
      top: Math.max(8, Math.min(rect.top + (rect.height - size) / 2, window.innerHeight - size - 8)),
      left,
    });
  };

  /** Closes the full-size view without reopening the hover preview on focus restore. */
  function closeViewer(): void {
    suppressFocusPreviewRef.current = true;
    setPreviewPosition(null);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeViewer();
    };
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!usableSrc) {
    return (
      <span className={`${className} ${placeholderClassName ?? "order-image-preview__placeholder"}`} role="img" aria-label={failed ? `${alt}加载失败` : fallbackLabel}>
        <PackageOpen size={Math.min(width, height) * 0.36} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className="order-image-preview">
      <button
        className="order-image-preview__trigger"
        ref={triggerRef}
        type="button"
        onClick={() => {
          setPreviewPosition(null);
          setOpen(true);
        }}
        onMouseEnter={showPreview}
        onMouseLeave={() => setPreviewPosition(null)}
        onFocus={() => {
          if (suppressFocusPreviewRef.current) {
            suppressFocusPreviewRef.current = false;
            return;
          }
          showPreview();
        }}
        onBlur={() => setPreviewPosition(null)}
        aria-label={`放大查看：${alt}`}
        title="点击查看大图"
      >
        <img className={className} src={usableSrc} alt={alt} width={width} height={height} loading="lazy" referrerPolicy="no-referrer" style={{ objectFit }} onError={() => setFailed(true)} />
      </button>
      {previewPosition && createPortal(
        <span className="order-image-preview__hover" aria-hidden="true" style={previewPosition}>
          <img src={usableSrc} alt="" />
        </span>,
        document.body,
      )}
      {open && createPortal(
        <div className="order-image-viewer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeViewer()}>
          <section className="order-image-viewer__dialog" role="dialog" aria-modal="true" aria-label={`${alt}大图`}>
            <button className="icon-button order-image-viewer__close" ref={closeRef} type="button" onClick={closeViewer} aria-label="关闭大图">
              <X size={20} aria-hidden="true" />
            </button>
            <img src={usableSrc} alt={alt} />
          </section>
        </div>,
        document.body,
      )}
    </span>
  );
}
