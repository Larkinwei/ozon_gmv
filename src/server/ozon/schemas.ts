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
  offer_id: z.string().default(""),
  images: z.array(z.string()).default([]),
  primary_image: z.array(z.string()).default([]),
  sources: z.array(z.object({ sku: z.union([z.string(), z.number()]) })).default([]),
});

export const productInfoListResponseSchema = z.object({
  items: z.array(productInfoSchema).default([]),
});

export type OzonPosting = z.infer<typeof ozonPostingSchema>;
export type OzonRoles = z.infer<typeof rolesResponseSchema>;
export type OzonProductInfo = z.infer<typeof productInfoSchema>;
