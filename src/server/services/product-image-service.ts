import type { ProductImageCandidate, ProductImagesRepository } from "../db/product-images-repository";
import type { OzonClient } from "../ozon/client";
import type { OzonProductInfo } from "../ozon/schemas";

const BATCH_SIZE = 1000;
const CACHE_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function safeImageUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function primaryImage(product: OzonProductInfo): string | null {
  return safeImageUrl(product.primary_image[0] ?? product.images[0]);
}

function matchProduct(
  candidate: ProductImageCandidate,
  bySku: Map<string, OzonProductInfo>,
  byOfferId: Map<string, OzonProductInfo>,
): OzonProductInfo | undefined {
  return bySku.get(candidate.sku) ?? byOfferId.get(candidate.offerId);
}

export class ProductImageService {
  private readonly activeStores = new Set<string>();

  public constructor(private readonly images: ProductImagesRepository) {}

  /** Backfills all missing or seven-day-old image links for one store. */
  public async refreshStore(storeId: string, client: OzonClient): Promise<void> {
    if (this.activeStores.has(storeId)) {
      return;
    }
    this.activeStores.add(storeId);
    try {
      while (true) {
        const candidates = this.images.listStale(storeId, Date.now() - CACHE_TTL_MILLISECONDS, BATCH_SIZE);
        if (candidates.length === 0) {
          return;
        }

        const products = await client.getProductInfo(candidates.map((candidate) => candidate.sku));
        const bySku = new Map<string, OzonProductInfo>();
        const byOfferId = new Map<string, OzonProductInfo>();
        for (const product of products) {
          if (product.offer_id) {
            byOfferId.set(product.offer_id, product);
          }
          for (const source of product.sources) {
            bySku.set(String(source.sku), product);
          }
        }

        this.images.saveBatch(
          storeId,
          candidates.map((candidate) => {
            const product = matchProduct(candidate, bySku, byOfferId);
            return { ...candidate, imageUrl: product ? primaryImage(product) : null };
          }),
          Date.now(),
        );
        if (candidates.length < BATCH_SIZE) {
          return;
        }
      }
    } finally {
      this.activeStores.delete(storeId);
    }
  }
}
