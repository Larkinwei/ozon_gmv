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

const productInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  product_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  offer_id: z.string().default(""),
  images: z.array(z.string()).default([]),
  primary_image: z.array(z.string()).default([]),
  sources: z.array(z.object({ sku: z.union([z.string(), z.number()]) })).default([]),
});

export const productInfoListResponseSchema = z.object({
  items: z.array(productInfoSchema).default([]),
});

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

export const productInfoLimitResponseSchema = z.object({
  daily_create_remaining: z.number().int().nonnegative().nullish(),
  total_product_limit: z.number().int().nonnegative().nullish(),
}).passthrough();

export const productPicturesImportResponseSchema = z.object({}).passthrough();
export const productPicturesInfoResponseSchema = z.object({}).passthrough();

export type OzonPosting = z.infer<typeof ozonPostingSchema>;
export type OzonRoles = z.infer<typeof rolesResponseSchema>;
export type OzonProductInfo = z.infer<typeof productInfoSchema>;
