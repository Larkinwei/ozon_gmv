import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { myDataSorts, selectionCandidateStatuses, selectionKeywordSorts, selectionMarketProductSorts } from "../../shared/contracts";
import { requireSession } from "../security/session";
import type { MyDataImportFile, MyDataModule } from "../selection/my-data-module";
import type { SelectionImportFile, SelectionModule } from "../selection/selection-module";

const idParamsSchema = z.object({ id: z.string().uuid() });
const keywordQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(selectionKeywordSorts).default("demandScore"),
  search: z.string().trim().max(200).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
});
const marketProductQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(selectionMarketProductSorts).default("orderedAmount"),
  search: z.string().trim().max(300).optional(),
  categoryLevel1: z.string().trim().max(300).optional(),
  categoryLevel3: z.string().trim().max(300).optional(),
  productFlag: z.string().trim().max(300).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
});
const candidateQuerySchema = z.object({
  status: z.enum(selectionCandidateStatuses).optional(),
  search: z.string().trim().max(200).optional(),
});
const myDataQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  captureDay: z.string().date().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  search: z.string().trim().max(300).optional(),
  keyword: z.string().trim().max(300).optional(),
  minMonthlyUnits: z.coerce.number().int().nonnegative().optional(),
  maxMonthlyUnits: z.coerce.number().int().nonnegative().optional(),
  minAov: z.coerce.number().nonnegative().optional(),
  maxAov: z.coerce.number().nonnegative().optional(),
  sort: z.enum(myDataSorts).default("monthlyUnits"),
}).refine((query) => !query.from || !query.to || query.from <= query.to, { message: "日期范围不正确", path: ["to"] });
const candidateCreateSchema = z.object({
  keywordId: z.string().uuid().optional(),
  marketProductId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(300),
  ozonUrl: z.string().trim().url().max(2000).optional(),
  category: z.string().trim().max(300).optional(),
  targetPrice: z.string().trim().max(50).optional(),
  note: z.string().trim().max(5000).optional(),
});
const candidateUpdateSchema = z.object({
  keywordId: z.string().uuid().nullable().optional(),
  marketProductId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(300).optional(),
  ozonUrl: z.string().trim().url().max(2000).nullable().optional(),
  category: z.string().trim().max(300).nullable().optional(),
  targetPrice: z.string().trim().max(50).nullable().optional(),
  status: z.enum(selectionCandidateStatuses).optional(),
  decisionReason: z.string().trim().max(5000).nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
});
const wordstatSettingsSchema = z.object({
  folderId: z.string().trim().min(1).max(300),
  apiKey: z.string().trim().min(1).max(2000).optional(),
});
const wordstatJobSchema = z.object({
  keywordIds: z.array(z.string().uuid()).min(1).max(100),
  force: z.boolean().default(false),
});
const importMappingSchema = z.object({
  phrase: z.string().min(1),
  searchCount: z.string().min(1),
  cartRate: z.string().min(1),
  cartRateUnit: z.enum(["percent", "fraction"]),
  orderRate: z.string().min(1),
  orderRateUnit: z.enum(["percent", "fraction"]),
  averagePrice: z.string().min(1).optional(),
});

interface MultipartImport extends SelectionImportFile {
  fields: Record<string, string>;
}

interface MultipartMyImport {
  files: MyDataImportFile[];
  fields: Record<string, string>;
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("SQLITE_CONSTRAINT");
}

function isFileTooLarge(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "FST_REQ_FILE_TOO_LARGE";
}

async function readMultipartImport(request: FastifyRequest): Promise<MultipartImport> {
  let file: SelectionImportFile | null = null;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (file) {
        throw new Error("每次只能上传一个文件");
      }
      file = { fileName: part.filename, content: await part.toBuffer() };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) {
    throw new Error("请选择要上传的报表文件");
  }
  return { ...file, fields };
}

async function readMultipartMyImport(request: FastifyRequest): Promise<MultipartMyImport> {
  const files: MyDataImportFile[] = [];
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      files.push({ fileName: part.filename, content: await part.toBuffer() });
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { files, fields };
}

/** Registers loopback-admin interfaces for product selection analysis. */
export function registerSelectionRoutes(app: FastifyInstance, selection: SelectionModule, myData: MyDataModule): void {
  app.get("/api/selection/overview", { preHandler: requireSession }, async () => selection.getOverview());

  app.get("/api/selection/imports", { preHandler: requireSession }, async () => selection.listImports());
  app.delete("/api/selection/imports/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!selection.deleteImport(id)) {
      return reply.code(404).send({ error: "IMPORT_NOT_FOUND", message: "导入记录不存在" });
    }
    return reply.code(204).send();
  });

  app.post("/api/selection/my/imports/preview", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartMyImport(request);
      return myData.previewImport(upload.files, upload.fields.folderName ?? "MY 数据文件夹");
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "MY_IMPORT_PREVIEW_FAILED",
        message: error instanceof Error ? error.message : "无法预览 MY 数据",
      });
    }
  });
  app.post("/api/selection/my/imports", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartMyImport(request);
      return reply.code(201).send(myData.commitImport(upload.files, upload.fields.folderName ?? "MY 数据文件夹"));
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "MY_IMPORT_FAILED",
        message: error instanceof Error ? error.message : "MY 数据导入失败",
      });
    }
  });
  app.get("/api/selection/my/imports", { preHandler: requireSession }, async () => myData.listImports());
  app.get("/api/selection/my/overview", { preHandler: requireSession }, async (request) => {
    const query = z.object({ captureDay: z.string().date().optional() }).parse(request.query);
    return myData.getOverview(query.captureDay);
  });
  app.get("/api/selection/my/products", { preHandler: requireSession }, async (request) => myData.listProducts(myDataQuerySchema.parse(request.query)));
  app.delete("/api/selection/my/data", { preHandler: requireSession }, async (_request, reply) => {
    myData.clearData();
    return reply.code(204).send();
  });
  app.post("/api/selection/imports/preview", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartImport(request);
      return await selection.previewImport({
        fileName: upload.fileName,
        content: upload.content,
        ...(upload.fields.sheetName ? { sheetName: upload.fields.sheetName } : {}),
      });
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "IMPORT_PREVIEW_FAILED",
        message: error instanceof Error ? error.message : "无法预览导入文件",
      });
    }
  });
  app.post("/api/selection/imports", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartImport(request);
      const mapping = upload.fields.mapping
        ? importMappingSchema.parse(JSON.parse(upload.fields.mapping))
        : undefined;
      const snapshotDate = z.string().date().parse(upload.fields.snapshotDate);
      const result = await selection.commitImport({
        fileName: upload.fileName,
        content: upload.content,
        snapshotDate,
        ...(mapping ? { mapping } : {}),
        ...(upload.fields.sheetName ? { sheetName: upload.fields.sheetName } : {}),
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: "IMPORT_ALREADY_EXISTS", message: "该报表文件已经导入" });
      }
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "IMPORT_FAILED",
        message: error instanceof Error ? error.message : "导入失败",
      });
    }
  });

  app.get("/api/selection/keywords", { preHandler: requireSession }, async (request) => {
    return selection.listKeywords(keywordQuerySchema.parse(request.query));
  });
  app.get("/api/selection/keywords/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const keyword = selection.getKeyword(id);
    return keyword ?? reply.code(404).send({ error: "KEYWORD_NOT_FOUND", message: "关键词不存在" });
  });

  app.get("/api/selection/products", { preHandler: requireSession }, async (request) => {
    return selection.listMarketProducts(marketProductQuerySchema.parse(request.query));
  });
  app.get("/api/selection/products/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const product = selection.getMarketProduct(id);
    return product ?? reply.code(404).send({ error: "MARKET_PRODUCT_NOT_FOUND", message: "热销商品不存在" });
  });

  app.get("/api/selection/candidates", { preHandler: requireSession }, async (request) => {
    return selection.listCandidates(candidateQuerySchema.parse(request.query));
  });
  app.post("/api/selection/candidates", { preHandler: requireSession }, async (request, reply) => {
    return reply.code(201).send(selection.createCandidate(candidateCreateSchema.parse(request.body)));
  });
  app.patch("/api/selection/candidates/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return selection.updateCandidate(id, candidateUpdateSchema.parse(request.body));
    } catch (error) {
      if (error instanceof Error && error.message === "候选商品不存在") {
        return reply.code(404).send({ error: "CANDIDATE_NOT_FOUND", message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/selection/sources/wordstat", { preHandler: requireSession }, async () => {
    return selection.viewWordstatSettings();
  });
  app.put("/api/selection/sources/wordstat", { preHandler: requireSession }, async (request) => {
    return selection.updateWordstatSettings(wordstatSettingsSchema.parse(request.body));
  });
  app.post("/api/selection/sources/wordstat/test", { preHandler: requireSession }, async (_request, reply) => {
    try {
      await selection.testWordstatConnection();
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({
        error: "WORDSTAT_CONNECTION_FAILED",
        message: error instanceof Error ? error.message : "Wordstat 连接失败",
      });
    }
  });
  app.get("/api/selection/wordstat/jobs", { preHandler: requireSession }, async () => selection.listWordstatJobs());
  app.post("/api/selection/wordstat/jobs", { preHandler: requireSession }, async (request, reply) => {
    const input = wordstatJobSchema.parse(request.body);
    try {
      return reply.code(202).send(selection.enqueueWordstat(input));
    } catch (error) {
      return reply.code(409).send({
        error: "WORDSTAT_JOB_REJECTED",
        message: error instanceof Error ? error.message : "无法创建 Wordstat 任务",
      });
    }
  });
  app.get("/api/selection/wordstat/jobs/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return selection.getWordstatJob(id);
    } catch {
      return reply.code(404).send({ error: "WORDSTAT_JOB_NOT_FOUND", message: "Wordstat 任务不存在" });
    }
  });
}
