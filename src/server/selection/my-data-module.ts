import { createHash, randomUUID } from "node:crypto";

import { parse } from "csv-parse/sync";
import Decimal from "decimal.js";

import type {
  Money,
  MyDataImportFilePreview,
  MyDataImportPreview,
  MyDataImportResult,
  MyDataImportView,
  MyDataOverview,
  MyDataProductPage,
  MyDataProductView,
  MyDataSort,
  SelectionImportError,
} from "../../shared/contracts";
import type { AppDatabase } from "../db/database";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_ROWS = 50_000;
const MAX_FILES_PER_IMPORT = 200;
const MAX_TOTAL_IMPORT_BYTES = 100 * 1024 * 1024;
const RUB_SCALE = 1000;

const requiredHeaders = [
  "SKU",
  "商品名",
  "当前价(₽)",
  "月销量",
  "月销售额(₽)",
  "展示量",
  "转化率(%)",
  "折扣(%)",
  "关键词",
  "URL",
  "主图",
  "状态",
  "采集时间",
] as const;

export interface MyDataImportFile {
  fileName: string;
  content: Buffer;
}

export interface MyDataQuery {
  page: number;
  pageSize: number;
  captureDay?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  search?: string | undefined;
  keyword?: string | undefined;
  minMonthlyUnits?: number | undefined;
  maxMonthlyUnits?: number | undefined;
  minAov?: number | undefined;
  maxAov?: number | undefined;
  sort: MyDataSort;
}

interface ParsedMyRow {
  sku: string;
  productName: string;
  currentPriceMilli: number;
  monthlyUnits: number;
  monthlySalesMilli: number;
  impressions: number;
  conversionRate: number;
  discountRate: number;
  keyword: string;
  productUrl: string;
  imageUrl: string | null;
  status: string;
  capturedAtMs: number;
  captureDay: string;
}

interface ParsedFile {
  fileHash: string;
  rows: ParsedMyRow[];
  errors: SelectionImportError[];
  duplicateRows: number;
  captureDays: string[];
}

interface ImportFileRow {
  id: string;
  file_hash: string;
}

interface ProductRow {
  id: string;
  sku: string;
  product_name: string;
  current_price_milli: number;
  monthly_units: number;
  monthly_sales_milli: number;
  impressions: number;
  conversion_rate: number;
  discount_rate: number;
  keyword: string;
  product_url: string;
  image_url: string | null;
  status: string;
  captured_at_ms: number;
  capture_day: string;
}

function delimiterForCsv(content: string): string {
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return [",", ";", "\t"].sort((left, right) => firstLine.split(right).length - firstLine.split(left).length)[0] ?? ",";
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").normalize("NFKC").trim().replace(/\s+/g, "");
}

function decimalValue(value: string, label: string): Decimal {
  const normalized = value.replace(/[\s\u00a0₽]/g, "").replace(/RUB/gi, "").replace(/%/g, "").replace(",", ".");
  const parsed = new Decimal(normalized || Number.NaN);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new Error(`${label}不是有效的非负数`);
  }
  return parsed;
}

function integerValue(value: string, label: string): number {
  const parsed = decimalValue(value, label);
  if (!parsed.isInteger() || parsed.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}必须是整数`);
  }
  return parsed.toNumber();
}

function scaledMoney(value: string, label: string): number {
  const scaled = decimalValue(value, label).times(RUB_SCALE).toDecimalPlaces(0);
  if (scaled.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}超出支持范围`);
  }
  return scaled.toNumber();
}

function percentageValue(value: string, label: string): number {
  const parsed = decimalValue(value, label);
  if (parsed.greaterThan(100)) {
    throw new Error(`${label}必须在 0% 到 100% 之间`);
  }
  return parsed.toNumber();
}

function captureDayFromTimestamp(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function moneyFromMilli(value: number | null): Money | null {
  if (value === null) {
    return null;
  }
  const amount = new Decimal(value).div(RUB_SCALE).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return { amount: amount || "0", currency: "RUB" };
}

function fileHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseCsvRows(content: Buffer): string[][] {
  const text = content.toString("utf8");
  const rows = parse(text, {
    bom: true,
    delimiter: delimiterForCsv(text),
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    to_line: MAX_FILE_ROWS + 2,
  }) as unknown[][];
  if (rows.length > MAX_FILE_ROWS + 1) {
    throw new Error(`单个 CSV 不能超过 ${MAX_FILE_ROWS.toLocaleString("zh-CN")} 行`);
  }
  return rows.map((row) => row.map((value) => String(value ?? "")));
}

function headerIndexes(headers: string[]): Record<(typeof requiredHeaders)[number], number> {
  const normalizedHeaders = headers.map(normalizeHeader);
  const indexes = {} as Record<(typeof requiredHeaders)[number], number>;
  for (const required of requiredHeaders) {
    const index = normalizedHeaders.indexOf(normalizeHeader(required));
    if (index < 0) {
      throw new Error(`缺少必需列：${required}`);
    }
    indexes[required] = index;
  }
  return indexes;
}

function parseMyFile(file: MyDataImportFile): ParsedFile {
  if (file.content.byteLength > MAX_FILE_BYTES) {
    throw new Error(`${file.fileName} 超过 10 MB 限制`);
  }
  if (!file.fileName.toLowerCase().endsWith(".csv")) {
    throw new Error(`${file.fileName} 不是 CSV 文件`);
  }
  const rows = parseCsvRows(file.content);
  const headers = rows.shift() ?? [];
  const indexes = headerIndexes(headers);
  const parsedRows: ParsedMyRow[] = [];
  const errors: SelectionImportError[] = [];
  const rowKeys = new Set<string>();
  let duplicateRows = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      const sku = row[indexes.SKU]?.trim() ?? "";
      const productName = row[indexes["商品名"]]?.trim() ?? "";
      const capturedAt = Date.parse(row[indexes["采集时间"]] ?? "");
      if (!sku || !productName || !Number.isFinite(capturedAt)) {
        throw new Error("SKU、商品名和采集时间不能为空或无效");
      }
      const parsed: ParsedMyRow = {
        sku,
        productName,
        currentPriceMilli: scaledMoney(row[indexes["当前价(₽)"]] ?? "0", "当前价"),
        monthlyUnits: integerValue(row[indexes["月销量"]] ?? "", "月销量"),
        monthlySalesMilli: scaledMoney(row[indexes["月销售额(₽)"]] ?? "", "月销售额"),
        impressions: integerValue(row[indexes["展示量"]] ?? "", "展示量"),
        conversionRate: percentageValue(row[indexes["转化率(%)"]] ?? "", "转化率"),
        discountRate: percentageValue(row[indexes["折扣(%)"]] ?? "", "折扣"),
        keyword: row[indexes["关键词"]]?.trim() ?? "",
        productUrl: row[indexes.URL]?.trim() ?? "",
        imageUrl: row[indexes["主图"]]?.trim() || null,
        status: row[indexes["状态"]]?.trim() || "unknown",
        capturedAtMs: capturedAt,
        captureDay: captureDayFromTimestamp(capturedAt),
      };
      const rowKey = `${parsed.sku}\u0000${parsed.captureDay}\u0000${parsed.keyword}`;
      if (rowKeys.has(rowKey)) {
        duplicateRows += 1;
      }
      rowKeys.add(rowKey);
      parsedRows.push(parsed);
    } catch (error) {
      if (errors.length < 50) {
        errors.push({ row: rowNumber, message: error instanceof Error ? error.message : "数据格式无效" });
      }
    }
  });

  return {
    fileHash: fileHash(file.content),
    rows: parsedRows,
    errors,
    duplicateRows,
    captureDays: [...new Set(parsedRows.map((row) => row.captureDay))].sort(),
  };
}

function listDateConditions(query: MyDataQuery, values: unknown[]): string[] {
  if (query.captureDay) {
    values.push(query.captureDay);
    return ["capture_day = ?"];
  }
  if (query.from) {
    values.push(query.from);
  }
  if (query.to) {
    values.push(query.to);
  }
  if (query.from && query.to) {
    return ["capture_day BETWEEN ? AND ?"];
  }
  if (query.from) {
    return ["capture_day >= ?"];
  }
  if (query.to) {
    return ["capture_day <= ?"];
  }
  return [];
}

function latestCaptureDay(database: AppDatabase): string | null {
  return (database.prepare<[], { value: string | null }>("SELECT MAX(capture_day) AS value FROM my_product_snapshots").get() as { value: string | null }).value;
}

function effectiveCaptureDay(database: AppDatabase, query: MyDataQuery): string | null {
  if (query.captureDay || query.from || query.to) {
    return null;
  }
  return latestCaptureDay(database);
}

/** Handles isolated MY CSV snapshots without coupling them to Ozon order data. */
export class MyDataModule {
  public constructor(private readonly database: AppDatabase) {}

  public previewImport(files: MyDataImportFile[], folderName: string): MyDataImportPreview {
    this.validateImportSize(files);
    const knownHashes = new Set((this.database.prepare<[], ImportFileRow>("SELECT id, file_hash FROM my_import_files").all() as ImportFileRow[]).map((row) => row.file_hash));
    const previews: MyDataImportFilePreview[] = [];
    for (const file of files) {
      try {
        const parsed = parseMyFile(file);
        previews.push({
          fileName: file.fileName,
          fileSize: file.content.byteLength,
          fileHash: parsed.fileHash,
          isDuplicateFile: knownHashes.has(parsed.fileHash),
          validRows: parsed.rows.length,
          invalidRows: parsed.errors.length,
          duplicateRows: parsed.duplicateRows,
          captureDays: parsed.captureDays,
          errors: parsed.errors,
        });
      } catch (error) {
        previews.push({
          fileName: file.fileName,
          fileSize: file.content.byteLength,
          fileHash: fileHash(file.content),
          isDuplicateFile: knownHashes.has(fileHash(file.content)),
          validRows: 0,
          invalidRows: 1,
          duplicateRows: 0,
          captureDays: [],
          errors: [{ row: 1, message: error instanceof Error ? error.message : "文件无法解析" }],
        });
      }
    }
    const newFiles = previews.filter((file) => !file.isDuplicateFile && file.validRows > 0).length;
    const duplicateFiles = previews.filter((file) => file.isDuplicateFile).length;
    return {
      folderName: folderName || "MY 数据文件夹",
      totalFiles: files.length,
      newFiles,
      duplicateFiles,
      validRows: previews.reduce((total, file) => total + file.validRows, 0),
      invalidRows: previews.reduce((total, file) => total + file.invalidRows, 0),
      duplicateRows: previews.reduce((total, file) => total + file.duplicateRows, 0),
      captureDays: [...new Set(previews.flatMap((file) => file.captureDays))].sort(),
      files: previews,
      canCommit: newFiles > 0,
    };
  }

  public commitImport(files: MyDataImportFile[], folderName: string): MyDataImportResult {
    this.validateImportSize(files);
    const batchId = randomUUID();
    const createdAtMs = Date.now();
    let importedFiles = 0;
    let duplicateFiles = 0;
    let validRows = 0;
    let invalidRows = 0;
    let duplicateRows = 0;
    const errors: SelectionImportError[] = [];
    const captureDays = new Set<string>();
    const knownHashes = new Set((this.database.prepare<[], ImportFileRow>("SELECT id, file_hash FROM my_import_files").all() as ImportFileRow[]).map((row) => row.file_hash));

    const importTransaction = this.database.transaction(() => {
      this.database.prepare("INSERT INTO my_import_batches (id, folder_name, file_count, valid_rows, invalid_rows, duplicate_rows, created_at_ms, status) VALUES (?, ?, ?, 0, 0, 0, ?, 'completed')")
        .run(batchId, folderName || "MY 数据文件夹", files.length, createdAtMs);
      for (const file of files) {
        let parsed: ParsedFile;
        try {
          parsed = parseMyFile(file);
        } catch (error) {
          invalidRows += 1;
          if (errors.length < 100) {
            errors.push({ row: 1, message: `${file.fileName}：${error instanceof Error ? error.message : "文件无法解析"}` });
          }
          continue;
        }
        validRows += parsed.rows.length;
        invalidRows += parsed.errors.length;
        duplicateRows += parsed.duplicateRows;
        parsed.errors.forEach((error) => {
          if (errors.length < 100) {
            errors.push({ row: error.row, message: `${file.fileName}：${error.message}` });
          }
        });
        parsed.captureDays.forEach((day) => captureDays.add(day));
        if (knownHashes.has(parsed.fileHash)) {
          duplicateFiles += 1;
          continue;
        }
        const fileId = randomUUID();
        this.database.prepare("INSERT INTO my_import_files (id, batch_id, file_name, file_hash, file_size, valid_rows, invalid_rows, duplicate_rows, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(fileId, batchId, file.fileName, parsed.fileHash, file.content.byteLength, parsed.rows.length, parsed.errors.length, parsed.duplicateRows, createdAtMs);
        importedFiles += 1;
        const upsert = this.database.prepare(`INSERT INTO my_product_snapshots
          (id, import_file_id, sku, product_name, current_price_milli, monthly_units, monthly_sales_milli, impressions, conversion_rate, discount_rate, keyword, product_url, image_url, status, captured_at_ms, capture_day)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (sku, capture_day, keyword) DO UPDATE SET
            import_file_id = excluded.import_file_id,
            product_name = excluded.product_name,
            current_price_milli = excluded.current_price_milli,
            monthly_units = excluded.monthly_units,
            monthly_sales_milli = excluded.monthly_sales_milli,
            impressions = excluded.impressions,
            conversion_rate = excluded.conversion_rate,
            discount_rate = excluded.discount_rate,
            product_url = excluded.product_url,
            image_url = excluded.image_url,
            status = excluded.status,
            captured_at_ms = excluded.captured_at_ms`);
        for (const row of parsed.rows) {
          upsert.run(randomUUID(), fileId, row.sku, row.productName, row.currentPriceMilli, row.monthlyUnits, row.monthlySalesMilli, row.impressions, row.conversionRate, row.discountRate, row.keyword, row.productUrl, row.imageUrl, row.status, row.capturedAtMs, row.captureDay);
        }
        knownHashes.add(parsed.fileHash);
      }
      const status = invalidRows > 0 ? (validRows > 0 ? "partial" : "failed") : "completed";
      this.database.prepare("UPDATE my_import_batches SET valid_rows = ?, invalid_rows = ?, duplicate_rows = ?, status = ? WHERE id = ?")
        .run(validRows, invalidRows, duplicateRows, status, batchId);
    });
    importTransaction();
    return { batchId, totalFiles: files.length, importedFiles, duplicateFiles, validRows, invalidRows, duplicateRows, captureDays: [...captureDays].sort(), errors };
  }

  public listImports(): MyDataImportView[] {
    const rows = this.database.prepare("SELECT id, folder_name, file_count, valid_rows, invalid_rows, duplicate_rows, created_at_ms, status FROM my_import_batches ORDER BY created_at_ms DESC").all() as Array<{ id: string; folder_name: string; file_count: number; valid_rows: number; invalid_rows: number; duplicate_rows: number; created_at_ms: number; status: MyDataImportView["status"] }>;
    return rows.map((row) => ({ id: row.id, folderName: row.folder_name, fileCount: row.file_count, validRows: row.valid_rows, invalidRows: row.invalid_rows, duplicateRows: row.duplicate_rows, createdAt: new Date(row.created_at_ms).toISOString(), status: row.status }));
  }

  public getOverview(captureDay?: string): MyDataOverview {
    const day = captureDay ?? latestCaptureDay(this.database);
    const values: unknown[] = [];
    const condition = day ? "WHERE capture_day = ?" : "";
    if (day) {
      values.push(day);
    }
    const row = this.database.prepare(`SELECT COUNT(*) AS product_count, COALESCE(SUM(monthly_units), 0) AS monthly_units, COALESCE(SUM(monthly_sales_milli), 0) AS monthly_sales_milli, COUNT(DISTINCT keyword) AS keyword_count FROM my_product_snapshots ${condition}`).get(...values) as { product_count: number; monthly_units: number; monthly_sales_milli: number; keyword_count: number };
    const captureDays = (this.database.prepare<[], { capture_day: string }>("SELECT DISTINCT capture_day FROM my_product_snapshots ORDER BY capture_day DESC").all() as Array<{ capture_day: string }>).map((item) => item.capture_day);
    const importCount = (this.database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM my_import_batches").get() as { count: number }).count;
    const averageOrderValue = row.monthly_units > 0 ? moneyFromMilli(new Decimal(row.monthly_sales_milli).div(row.monthly_units).toDecimalPlaces(0).toNumber()) : null;
    return { productCount: row.product_count, monthlyUnits: row.monthly_units, monthlySales: moneyFromMilli(row.monthly_sales_milli) as Money, averageOrderValue, latestCaptureDay: latestCaptureDay(this.database), captureDays, keywordCount: row.keyword_count, importCount };
  }

  public listProducts(query: MyDataQuery): MyDataProductPage {
    const values: unknown[] = [];
    const conditions = listDateConditions(query, values);
    const defaultDay = effectiveCaptureDay(this.database, query);
    if (defaultDay) {
      values.push(defaultDay);
      conditions.push("capture_day = ?");
    }
    if (query.search) {
      values.push(`%${query.search}%`, `%${query.search}%`);
      conditions.push("(product_name LIKE ? OR sku LIKE ?)");
    }
    if (query.keyword) {
      values.push(query.keyword);
      conditions.push("keyword = ?");
    }
    if (query.minMonthlyUnits !== undefined) {
      values.push(query.minMonthlyUnits);
      conditions.push("monthly_units >= ?");
    }
    if (query.maxMonthlyUnits !== undefined) {
      values.push(query.maxMonthlyUnits);
      conditions.push("monthly_units <= ?");
    }
    if (query.minAov !== undefined) {
      values.push(query.minAov * RUB_SCALE);
      conditions.push("monthly_sales_milli * 1.0 / NULLIF(monthly_units, 0) >= ?");
    }
    if (query.maxAov !== undefined) {
      values.push(query.maxAov * RUB_SCALE);
      conditions.push("monthly_sales_milli * 1.0 / NULLIF(monthly_units, 0) <= ?");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy: Record<MyDataSort, string> = {
      monthlyUnits: "monthly_units DESC",
      monthlySales: "monthly_sales_milli DESC",
      averageOrderValue: "monthly_sales_milli * 1.0 / NULLIF(monthly_units, 0) DESC",
      conversionRate: "conversion_rate DESC",
      impressions: "impressions DESC",
    };
    const count = (this.database.prepare(`SELECT COUNT(*) AS count FROM my_product_snapshots ${where}`).get(...values) as { count: number }).count;
    const offset = (query.page - 1) * query.pageSize;
    const rows = this.database.prepare(`SELECT id, sku, product_name, current_price_milli, monthly_units, monthly_sales_milli, impressions, conversion_rate, discount_rate, keyword, product_url, image_url, status, captured_at_ms, capture_day FROM my_product_snapshots ${where} ORDER BY ${orderBy[query.sort]}, captured_at_ms DESC LIMIT ? OFFSET ?`).all(...values, query.pageSize, offset) as ProductRow[];
    const captureDays = (this.database.prepare<[], { capture_day: string }>("SELECT DISTINCT capture_day FROM my_product_snapshots ORDER BY capture_day DESC").all() as Array<{ capture_day: string }>).map((item) => item.capture_day);
    const keywordWhere = conditions.length > 0 ? `${where} AND keyword <> ''` : "WHERE keyword <> ''";
    const keywords = (this.database.prepare(`SELECT DISTINCT keyword FROM my_product_snapshots ${keywordWhere} ORDER BY keyword`).all(...values) as Array<{ keyword: string }>).map((item) => item.keyword);
    return { items: rows.map((row) => this.toProductView(row)), page: query.page, pageSize: query.pageSize, total: count, latestCaptureDay: latestCaptureDay(this.database), captureDays, keywords };
  }

  public clearData(): void {
    const clear = this.database.transaction(() => {
      this.database.exec("DELETE FROM my_product_snapshots; DELETE FROM my_import_files; DELETE FROM my_import_batches;");
    });
    clear();
  }

  private validateImportSize(files: MyDataImportFile[]): void {
    if (files.length === 0) {
      throw new Error("请选择包含 CSV 文件的文件夹");
    }
    if (files.length > MAX_FILES_PER_IMPORT) {
      throw new Error(`单次最多导入 ${MAX_FILES_PER_IMPORT} 个 CSV 文件`);
    }
    const totalBytes = files.reduce((total, file) => total + file.content.byteLength, 0);
    if (totalBytes > MAX_TOTAL_IMPORT_BYTES) {
      throw new Error("单次导入文件夹不能超过 100 MB");
    }
  }

  private toProductView(row: ProductRow): MyDataProductView {
    const aovMilli = row.monthly_units > 0 ? new Decimal(row.monthly_sales_milli).div(row.monthly_units).toDecimalPlaces(0).toNumber() : null;
    return {
      id: row.id,
      sku: row.sku,
      productName: row.product_name,
      currentPrice: moneyFromMilli(row.current_price_milli) as Money,
      monthlyUnits: row.monthly_units,
      monthlySales: moneyFromMilli(row.monthly_sales_milli) as Money,
      averageOrderValue: moneyFromMilli(aovMilli),
      impressions: row.impressions,
      conversionRate: row.conversion_rate,
      discountRate: row.discount_rate,
      keyword: row.keyword,
      productUrl: row.product_url,
      imageUrl: row.image_url,
      status: row.status,
      capturedAt: new Date(row.captured_at_ms).toISOString(),
      captureDay: row.capture_day,
    };
  }
}
