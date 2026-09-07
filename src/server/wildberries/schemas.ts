import { z } from "zod";

export const wildberriesReportRowSchema = z.record(z.string(), z.unknown());
export const wildberriesReportResponseSchema = z.array(wildberriesReportRowSchema);

export const wildberriesBalanceResponseSchema = z.object({
  currency: z.union([z.string(), z.number()]).transform(String).nullish(),
  current: z.union([z.string(), z.number()]).transform(String).nullish(),
  for_withdraw: z.union([z.string(), z.number()]).transform(String).nullish(),
}).passthrough();

export type WildberriesReportRow = z.infer<typeof wildberriesReportRowSchema>;
export type WildberriesBalanceResponse = z.infer<typeof wildberriesBalanceResponseSchema>;
