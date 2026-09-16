import Image from "next/image";
import stunksLogo from "../../../../Asset/logo-transparent.png";

interface BrandMarkProps {
  readonly size?: "sm" | "md" | "lg" | "hero";
  readonly decorative?: boolean;
}

/**
 * Approved local STUNKS mark.
 *
 * Static import keeps the brand asset versioned with the repository, optimized by
 * Next.js, and independent of an external image host. It is decorative in the header
 * because adjacent text always names the product.
 */
export function BrandMark({ size = "md", decorative = true }: BrandMarkProps) {
  const pixelSize = size === "sm" ? 34 : size === "lg" ? 98 : size === "hero" ? 430 : 54;

  return (
    <span
      className={`brand-mark brand-mark-${size}`}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "STUNKS"}
    >
      <Image
        src={stunksLogo}
        alt=""
        width={pixelSize}
        height={pixelSize}
        sizes={`${pixelSize}px`}
        className="brand-mark-image"
      />
    </span>
  );
}
