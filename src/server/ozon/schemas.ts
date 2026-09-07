import { z } from "zod";

const moneySchema = z.object({
  amount: z.string(),
  currency: z.string().min(3).max(3),
});

const productSchema = z.object({
  sku: z.union([z.string(), z.number()]),
  offer_id: z.string().default(""),
  name: z.string().default(""),
  quantity: z.number().int().positive(),
  price: z.union([moneySchema, z.string(), z.number()]),
  currency_code: z.string().min(3).max(3).optional(),
});

export const ozonPostingSchema = z.object({
  posting_number: z.string().min(1),
  order_number: z.string().min(1),
  created_at: z.string().datetime().optional(),
  in_process_at: z.string().datetime().optional(),
  status: z.string().min(1),
  substatus: z.string().nullish(),
  delivery_schema: z.string().optional(),
  products: z.array(productSchema),
});

export const postingListResponseSchema = z.object({
  cursor: z.string().nullish(),
  has_next: z.boolean().default(false),
  postings: z.array(ozonPostingSchema).default([]),
});

export const rolesResponseSchema = z.object({
  expires_at: z.string().datetime().nullish(),
  roles: z.array(
    z.object({
      name: z.string().nullish(),
      methods: z.array(z.string()).default([]),
    }),
  ),
});

/** Minimal contract-currency response returned by the seller account endpoint. */
export const sellerInfoResponseSchema = z.object({
  company: z.object({
    currency: z.string().nullish(),
    country: z.string().nullish(),
  }).passthrough().nullish().default({}),
}).passthrough();

const productInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  product_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  offer_id: z.string().default(""),
  images: z.array(z.string()).default([]),
  primary_image: z.array(z.string()).default([]),
  sources: z.array(z.object({ sku: z.union([z.string(), z.number()]) })).default([]),
  // Some Ozon accounts omit these fields. Treat invalid/zero values as absent
  // so product-info lookup remains usable for existing-offer detection.
  type_id: z.union([z.string(), z.number()]).transform(Number).refine((value) => Number.isInteger(value) && value > 0).nullish().catch(null),
  description_category_id: z.union([z.string(), z.number()]).transform(Number).refine((value) => Number.isInteger(value) && value > 0).nullish().catch(null),
});

export const productInfoListResponseSchema = z.object({
  items: z.array(productInfoSchema).default([]),
});

export interface OzonDescriptionCategoryNode {
  description_category_id: number | null;
  category_id: number | null;
  type_id: number | null;
  title: string;
  category_name: string;
  type_name: string;
  children: OzonDescriptionCategoryNode[];
}

const descriptionCategoryTreeNodeSchema: z.ZodType<OzonDescriptionCategoryNode> = z.lazy(() => z.object({
  description_category_id: z.union([z.string(), z.number()]).transform(Number).refine((value) => Number.isInteger(value) && value > 0).nullish().catch(null).default(null),
  category_id: z.union([z.string(), z.number()]).transform(Number).refine((value) => Number.isInteger(value) && value > 0).nullish().catch(null).default(null),
  type_id: z.union([z.string(), z.number()]).transform(Number).refine((value) => Number.isInteger(value) && value > 0).nullish().catch(null).default(null),
  title: z.string().default(""),
  category_name: z.string().default(""),
  type_name: z.string().default(""),
  children: z.array(descriptionCategoryTreeNodeSchema).default([]),
}).passthrough());

export const descriptionCategoryTreeResponseSchema = z.object({
  result: z.array(descriptionCategoryTreeNodeSchema).default([]),
}).passthrough();

/** Raw category-attribute response; Ozon adds fields as category rules evolve. */
export const descriptionCategoryAttributesResponseSchema = z.object({
  result: z.union([
    z.array(z.unknown()),
    z.object({ attributes: z.array(z.unknown()).default([]) }).passthrough(),
  ]).default([]),
}).passthrough();

/** Raw dictionary-value response used by searchable category attributes. */
export const descriptionCategoryAttributeValuesResponseSchema = z.object({
  result: z.union([
    z.array(z.unknown()),
    z.object({ values: z.array(z.unknown()).default([]) }).passthrough(),
  ]).default([]),
}).passthrough();

const identifierSchema = z.union([z.string(), z.number()]).transform(String);

export const productImportResponseSchema = z.object({
  result: z.object({
    task_id: identifierSchema,
    unmatched_sku_list: z.array(identifierSchema).default([]),
  }),
}).passthrough();

export const productImportInfoResponseSchema = z.object({
  result: z.object({
    items: z.array(z.object({
      offer_id: z.string().default(""),
      product_id: identifierSchema.nullish(),
      status: z.string().default("unknown"),
      errors: z.array(z.object({
        code: z.string().nullish(),
        message: z.string().nullish(),
        level: z.string().nullish(),
      }).passthrough()).default([]),
    }).passthrough()).default([]),
  }),
}).passthrough();

export const warehouseListResponseSchema = z.object({
  warehouses: z.array(z.object({
    warehouse_id: identifierSchema.nullish(),
    id: identifierSchema.nullish(),
    name: z.string().default(""),
    status: z.string().default("unknown"),
  }).passthrough()).default([]),
}).passthrough();

/** Per-offer result returned by Ozon after a stock update or stock readback. */
const stockResultItemSchema = z.object({
  offer_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  product_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  warehouse_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  updated: z.boolean().nullish(),
  errors: z.array(z.union([
    z.string(),
    z.object({ code: z.string().nullish(), message: z.string().nullish() }).passthrough(),
  ])).default([]),
  stock: z.union([z.number(), z.string()]).transform(Number).nullish(),
  present: z.union([z.number(), z.string()]).transform(Number).nullish(),
  reserved: z.union([z.number(), z.string()]).transform(Number).nullish(),
}).passthrough();

/** Response contract for `/v2/products/stocks`. */
export const stockUpdateResponseSchema = z.object({
  result: z.union([
    z.object({ items: z.array(stockResultItemSchema).default([]) }).passthrough(),
    z.array(stockResultItemSchema),
  ]),
}).passthrough();

/** Response contract for the current FBS warehouse stock readback endpoint. */
export const stockReadbackResponseSchema = z.object({
  result: z.union([
    z.object({ items: z.array(stockResultItemSchema).default([]) }).passthrough(),
    z.array(stockResultItemSchema),
  ]),
}).passthrough();

export const productInfoLimitResponseSchema = z.object({
  daily_create_remaining: z.number().int().nonnegative().nullish(),
  total_product_limit: z.number().int().nonnegative().nullish(),
}).passthrough();

export const productPicturesImportResponseSchema = z.object({}).passthrough();
export const productPicturesInfoResponseSchema = z.object({}).passthrough();

export type OzonPosting = z.infer<typeof ozonPostingSchema>;
export type OzonRoles = z.infer<typeof rolesResponseSchema>;
export type OzonProductInfo = z.infer<typeof productInfoSchema>;
