import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { StoreOperationsReader } from "../services/store-operations-service";
import { requireSession } from "../security/session";

const overviewQuerySchema = z.object({ storeIds: z.string().optional() });
const questionParamsSchema = z.object({
  storeId: z.string().uuid(),
  questionId: z.string().trim().min(1).max(200),
});

function parseStoreIds(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((id) => z.string().uuid().parse(id.trim()))
    .filter(Boolean);
}

/** Registers read-only store finance and buyer-question endpoints for the admin app. */
export function registerStoreOperationsRoutes(app: FastifyInstance, operations: StoreOperationsReader): void {
  app.get("/api/store-operations/overview", { preHandler: requireSession }, async (request) => {
    const query = overviewQuerySchema.parse(request.query);
    return operations.getOverview(parseStoreIds(query.storeIds));
  });

  app.get("/api/store-operations/questions/:storeId/:questionId", { preHandler: requireSession }, async (request, reply) => {
    const { storeId, questionId } = questionParamsSchema.parse(request.params);
    const question = await operations.getQuestionDetail(storeId, questionId);
    if (!question) {
      return reply.code(404).send({ error: "QUESTION_NOT_FOUND", message: "问题不存在或店铺未启用" });
    }
    return question;
  });
}
