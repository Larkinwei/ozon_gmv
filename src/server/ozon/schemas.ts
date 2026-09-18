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
  delivering_date: z.string().datetime().nullish(),
  shipment_date: z.string().datetime().nullish(),
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

function unwrapResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return record.result && typeof record.result === "object" ? record.result : value;
}

const financeAmountSchema = z.object({
  currency_code: z.union([z.string(), z.number()]).transform(String).nullish(),
  value: z.union([z.string(), z.number()]).transform(String).nullish(),
}).passthrough();

const financeCashflowSchema = z.object({
  amount: financeAmountSchema.nullish(),
  fee: financeAmountSchema.nullish(),
  amount_details: z.object({
    revenue: financeAmountSchema.nullish(),
  }).passthrough().nullish(),
}).passthrough();

const financeBalancePayloadSchema = z.object({
  cashflows: z.object({
    returns: financeCashflowSchema.nullish(),
    sales: financeCashflowSchema.nullish(),
    services: z.array(z.object({
      amount: financeAmountSchema.nullish(),
      name: z.string().nullish(),
    }).passthrough()).default([]),
  }).passthrough().nullish(),
  total: z.object({
    accrued: financeAmountSchema.nullish(),
    closing_balance: financeAmountSchema.nullish(),
    opening_balance: financeAmountSchema.nullish(),
    payments: z.array(financeAmountSchema).default([]),
  }).passthrough().nullish(),
}).passthrough();

export const financeBalanceResponseSchema = z.preprocess(unwrapResult, financeBalancePayloadSchema);

const accrualMoneySchema = z.object({
  amount: z.union([z.string(), z.number()]).transform(String),
  currency: z.string().min(3).max(3).transform((value) => value.toUpperCase()),
}).passthrough();

const accrualTypeIdSchema = z.union([z.string(), z.number()]).transform(String);

const financeCommissionSchema = z.object({
  seller_price: accrualMoneySchema.nullish(),
  sale_commission: accrualMoneySchema.nullish(),
  commission: accrualMoneySchema.nullish(),
  sale_amount: accrualMoneySchema.nullish(),
  sale_price: accrualMoneySchema.nullish(),
  bonus: accrualMoneySchema.nullish(),
  coinvestment: accrualMoneySchema.nullish(),
}).passthrough();

const financeDeliveryServiceSchema = z.object({
  type_id: accrualTypeIdSchema,
  accrued: accrualMoneySchema.nullish(),
}).passthrough();

const financePostingProductSchema = z.object({
  sku: z.union([z.string(), z.number()]).transform(String),
  quantity: z.union([z.number(), z.string()]).transform(Number).nullish(),
  commission: financeCommissionSchema.nullish(),
  delivery: z.object({
    total_accrued: accrualMoneySchema.nullish(),
    services: z.array(financeDeliveryServiceSchema).default([]),
  }).passthrough().nullish(),
}).passthrough();

const financeItemFeeSchema = z.object({
  type_id: accrualTypeIdSchema,
  accrued: accrualMoneySchema.nullish(),
}).passthrough();

const financeAccrualSchema = z.object({
  accrued_category: z.string().default("UNSPECIFIED"),
  date: z.string().default(""),
  type_id: accrualTypeIdSchema.nullish(),
  unit_number: z.union([z.string(), z.number()]).transform(String).default(""),
  total_amount: accrualMoneySchema.nullish(),
  posting: z.object({
    products: z.array(financePostingProductSchema).default([]),
  }).passthrough().nullish(),
  item_fees: z.object({
    fees: z.array(z.object({
      sku: z.union([z.string(), z.number()]).transform(String),
      fees: z.array(financeItemFeeSchema).default([]),
    }).passthrough()).default([]),
  }).passthrough().nullish(),
  non_item_fee: z.object({
    type_id: accrualTypeIdSchema,
    accrued: accrualMoneySchema.nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const financeAccrualByDayResponseSchema = z.object({
  accruals: z.array(financeAccrualSchema).default([]),
  last_id: z.union([z.string(), z.number()]).transform(String).nullish(),
}).passthrough();

export const financeAccrualPostingsResponseSchema = z.object({
  posting_accruals: z.array(z.object({
    posting_number: z.string(),
    accruals: z.array(z.object({
      accrual_date: z.string(),
      accrued: accrualMoneySchema,
      quantity: z.number().int().default(0),
      seller_price: accrualMoneySchema.nullish(),
      sku: z.union([z.string(), z.number()]).transform(String),
      type_id: accrualTypeIdSchema,
    }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough();

export const financeAccrualTypesResponseSchema = z.object({
  accrual_types: z.array(z.object({
    id: accrualTypeIdSchema,
    name: z.string().default(""),
    description: z.string().default(""),
  }).passthrough()).default([]),
}).passthrough();

/** The cash-flow report evolves independently from accrual line fields; retain it as raw JSON. */
export const financeCashFlowStatementResponseSchema = z.unknown();

const questionItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  question_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  answers_count: z.coerce.number().int().nonnegative().default(0),
  product_url: z.string().nullish(),
  question_link: z.string().nullish(),
  published_at: z.string().nullish(),
  sku: z.union([z.string(), z.number()]).transform(String).nullish(),
  status: z.string().nullish(),
  text: z.string().default(""),
  product_name: z.string().nullish(),
  is_answered: z.boolean().nullish(),
  urgency_level: z.string().nullish(),
  category_name: z.string().nullish(),
}).passthrough();

const questionListPayloadSchema = z.object({
  questions: z.array(questionItemSchema).default([]),
  last_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  has_next: z.boolean().default(false),
}).passthrough();

export const questionListResponseSchema = z.preprocess(unwrapResult, questionListPayloadSchema);

export const questionCountResponseSchema = z.preprocess(unwrapResult, z.object({
  all: z.coerce.number().int().nonnegative().default(0),
  new: z.coerce.number().int().nonnegative().default(0),
  processed: z.coerce.number().int().nonnegative().default(0),
  unprocessed: z.coerce.number().int().nonnegative().default(0),
  viewed: z.coerce.number().int().nonnegative().default(0),
}).passthrough());

export const questionInfoResponseSchema = z.preprocess(unwrapResult, questionItemSchema);

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
export type OzonFinanceAccrual = z.infer<typeof financeAccrualSchema>;
export type OzonFinanceAccrualPostings = z.infer<typeof financeAccrualPostingsResponseSchema>["posting_accruals"][number];
export type OzonFinanceAccrualType = z.infer<typeof financeAccrualTypesResponseSchema>["accrual_types"][number];
