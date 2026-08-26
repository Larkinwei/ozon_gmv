import type { ResellSourceView } from "./contracts";

function positiveAmount(value: unknown): boolean {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0;
}

function positiveCount(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

/**
 * Merges a Seller bridge snapshot without allowing its intentionally empty
 * analytics fields to erase values from the MY snapshot.
 */
export function mergeSellerSource(base: ResellSourceView, seller: ResellSourceView): ResellSourceView {
  const baseImages = Array.isArray(base.images) ? base.images : [];
  const sellerImages = Array.isArray(seller.images) ? seller.images : [];
  const images = sellerImages.length > 0 ? sellerImages : baseImages;
  const packageDimensions = seller.packageDimensions || base.packageDimensions;
  const description = seller.description || base.description;
  const brand = seller.brand || base.brand;
  const category = seller.category || base.category;
  const typeName = seller.typeName || base.typeName;
  const attributes = seller.attributes && Object.keys(seller.attributes).length > 0 ? seller.attributes : base.attributes;
  const barcode = seller.barcode || base.barcode;
  const fieldSources = { ...(base.fieldSources ?? {}), ...(seller.fieldSources ?? {}) };
  const missingFields = [...new Set([...(base.missingFields ?? []), ...(seller.missingFields ?? [])])];
  return {
    ...base,
    ...seller,
    sku: seller.sku || base.sku,
    productName: seller.productName || base.productName,
    ...(description ? { description } : {}),
    ...(brand ? { brand } : {}),
    ...(category ? { category } : {}),
    ...(typeName ? { typeName } : {}),
    ...(attributes ? { attributes } : {}),
    ...(packageDimensions ? { packageDimensions } : {}),
    ...(barcode ? { barcode } : {}),
    typeId: seller.typeId && seller.typeId > 0 ? seller.typeId : base.typeId,
    descriptionCategoryId: seller.descriptionCategoryId && seller.descriptionCategoryId > 0
      ? seller.descriptionCategoryId
      : base.descriptionCategoryId,
    currentPrice: positiveAmount(seller.currentPrice?.amount) ? seller.currentPrice : base.currentPrice,
    productUrl: seller.productUrl || base.productUrl,
    imageUrl: images[0]?.url || seller.imageUrl || base.imageUrl,
    images,
    monthlyUnits: positiveCount(seller.monthlyUnits) ? seller.monthlyUnits : base.monthlyUnits,
    monthlySales: positiveAmount(seller.monthlySales?.amount) ? seller.monthlySales : base.monthlySales,
    captureDay: seller.captureDay || base.captureDay,
    sourceType: "seller_bridge",
    fieldSources,
    missingFields,
  };
}
