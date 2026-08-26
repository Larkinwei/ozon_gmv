import { describe, expect, it } from "vitest";

import { resolveTypeDetailsFromCategoryTree, resolveTypeFromCategoryTree } from "../src/server/selection/resell-module";
import { ResellModule } from "../src/server/selection/resell-module";
import { StoresRepository } from "../src/server/db/stores-repository";
import { MyDataModule } from "../src/server/selection/my-data-module";
import { ResellImageService } from "../src/server/selection/resell-image-service";
import { encryptSecret } from "../src/server/security/encryption";
import { createTestDatabase } from "./test-context";
import type { OzonDescriptionCategoryNode } from "../src/server/ozon/schemas";
import type { ResellSourceView } from "../src/shared/contracts";
import type { ResellPreflightView } from "../src/shared/contracts";

function source(overrides: Partial<ResellSourceView>): ResellSourceView {
  return {
    sku: "1001",
    productName: "商品",
    category: "宠物/动物梳子",
    typeId: null,
    descriptionCategoryId: null,
    currentPrice: { amount: "0", currency: "RUB" },
    productUrl: "",
    imageUrl: null,
    images: [],
    monthlyUnits: 0,
    monthlySales: { amount: "0", currency: "RUB" },
    captureDay: "",
    ...overrides,
  };
}

function tree(): OzonDescriptionCategoryNode[] {
  return [{
    description_category_id: 95249,
    category_id: null,
    type_id: null,
    title: "",
    category_name: "宠物",
    type_name: "",
    children: [{
      description_category_id: null,
      category_id: null,
      type_id: 123456,
      title: "",
      category_name: "",
      type_name: "动物梳子",
      children: [],
    }],
  }];
}

function chinesePetSpongeTree(): OzonDescriptionCategoryNode[] {
  return [{
    description_category_id: 100,
    category_id: null,
    type_id: null,
    title: "",
    category_name: "宠物用品",
    type_name: "",
    children: [{
      description_category_id: 101,
      category_id: null,
      type_id: null,
      title: "",
      category_name: "宠物护理用品",
      type_name: "",
      children: [{
        description_category_id: null,
        category_id: null,
        type_id: 95236,
        title: "",
        category_name: "",
        type_name: "宠物洗澡海绵",
        children: [],
      }],
    }],
  }];
}

describe("Seller type_id resolution", () => {
  it("returns the existing task id for a duplicate publish business key", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const storeId = "33333333-3333-4333-8333-333333333333";
    await stores.create({
      id: storeId,
      name: "重复任务店铺",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("secret", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBO"],
      apiKeyExpiresAt: null,
    });
    const existingTaskId = "44444444-4444-4444-8444-444444444444";
    context.database.prepare(`INSERT INTO resell_tasks
      (id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat, stock,
       fulfillment_mode, warehouse_id, title, description, attributes_json, status, source_type,
       source_snapshot_json, idempotency_key, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'quick', '10', NULL, 'RUB', '0', 2, 'FBO', 'warehouse', '商品', NULL, NULL,
       'failed', 'follow_sell', ?, NULL, 1, 1)`).run(existingTaskId, storeId, "1001", "MY-1001", JSON.stringify(source({ sku: "1001" })));
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images);
    const validPreflight = {
      valid: true,
      source: source({ sku: "1001" }),
      store: { id: storeId, name: "重复任务店铺", color: "#3B82F6", fulfillmentModes: ["FBO"] },
      warehouses: [{ id: "warehouse", name: "仓库", status: "created" }],
      existingOffer: null,
      limits: { dailyCreateRemaining: null, totalProductLimit: null },
      contractCurrency: "RUB",
      warnings: [],
      errors: [],
      requiredAttributes: [],
      missingRequiredFields: [],
      packageDimensions: null,
      quickCreateAllowed: true,
      mustUseEdit: false,
    } satisfies ResellPreflightView;
    module.preflight = async () => validPreflight;
    try {
      await expect(module.createTask({
        sourceSku: "1001",
        sourceType: "follow_sell",
        sourceSnapshot: source({ sku: "1001" }),
        storeId,
        mode: "quick",
        offerId: "MY-1001",
        price: "10",
        currency: "RUB",
        vat: "0",
        stock: 2,
        fulfillmentMode: "FBO",
        warehouseId: "warehouse",
        images: [],
      })).rejects.toMatchObject({ existingTaskId });
    } finally {
      context.cleanup();
    }
  });

  it("deletes failed tasks but protects active tasks", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const storeId = "55555555-5555-4555-8555-555555555555";
    await stores.create({
      id: storeId,
      name: "任务清理店铺",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("secret", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBO"],
      apiKeyExpiresAt: null,
    });
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images);
    const insert = context.database.prepare(`INSERT INTO resell_tasks
      (id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat, stock,
       fulfillment_mode, warehouse_id, title, description, attributes_json, status, source_type,
       source_snapshot_json, idempotency_key, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'quick', '10', NULL, 'RUB', '0', 2, 'FBO', 'warehouse', '商品', NULL, NULL,
       ?, 'follow_sell', ?, NULL, 1, 1)`);
    insert.run("66666666-6666-4666-8666-666666666666", storeId, "1002", "MY-1002", "failed", JSON.stringify(source({ sku: "1002" })));
    insert.run("77777777-7777-4777-8777-777777777777", storeId, "1003", "MY-1003", "creating", JSON.stringify(source({ sku: "1003" })));
    try {
      expect(module.deleteFailedTask("66666666-6666-4666-8666-666666666666")).toBe(true);
      expect(context.database.prepare("SELECT id FROM resell_tasks WHERE id = ?").get("66666666-6666-4666-8666-666666666666")).toBeUndefined();
      expect(() => module.deleteFailedTask("77777777-7777-4777-8777-777777777777")).toThrow("只有失败或需要补充的任务可以删除");
    } finally {
      context.cleanup();
    }
  });

  it("matches a type leaf through its parent description category id", () => {
    expect(resolveTypeFromCategoryTree(source({ descriptionCategoryId: 95249 }), tree())).toBe(123456);
  });

  it("matches a unique readable category/type name", () => {
    expect(resolveTypeFromCategoryTree(source({ descriptionCategoryId: null }), tree())).toBe(123456);
  });

  it("matches the Seller-provided type name before falling back to the display category", () => {
    expect(resolveTypeFromCategoryTree(source({ category: "", typeName: "动物梳子" }), tree())).toBe(123456);
  });

  it("carries the nearest ancestor description category to a nested type leaf", () => {
    expect(resolveTypeDetailsFromCategoryTree(source({ category: "宠物用品/宠物护理用品/宠物洗澡海绵" }), chinesePetSpongeTree())).toEqual({
      typeId: 95236,
      descriptionCategoryId: 101,
    });
  });

  it("does not use a category id as a product type id", () => {
    expect(resolveTypeFromCategoryTree(source({ category: "", descriptionCategoryId: 95249 }), [{
      description_category_id: 95249,
      category_id: 9988,
      type_id: null,
      title: "",
      category_name: "",
      type_name: "",
      children: [],
    }])).toBeNull();
  });

  it("rejects an ambiguous category name", () => {
    const nodes = tree();
    const first = nodes[0]?.children[0];
    if (!first || !nodes[0]) throw new Error("test fixture is incomplete");
    nodes[0].children.push({ ...first, type_id: 654321 });
    expect(resolveTypeFromCategoryTree(source({ descriptionCategoryId: null }), nodes)).toBeNull();
  });

  it("enriches a Seller snapshot with the target store type tree", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const storeId = "11111111-1111-4111-8111-111111111111";
    await stores.create({
      id: storeId,
      name: "目标店铺",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("secret", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBO"],
      apiKeyExpiresAt: null,
    });
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as { language?: string } : {};
      const body = url.endsWith("/v3/product/info/list")
        ? { items: [] }
        : { result: requestBody.language === "ZH_HANS" ? chinesePetSpongeTree() : tree() };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images, { fetchImplementation });
    try {
      await expect(module.enrichSource({
        storeId,
        sourceType: "seller_bridge",
        sourceSku: "1001",
        sourceSnapshot: source({ descriptionCategoryId: 95249 }),
      })).resolves.toMatchObject({ typeId: 123456, descriptionCategoryId: 95249 });

      await expect(module.enrichSource({
        storeId,
        sourceType: "seller_bridge",
        sourceSku: "2101377120",
        sourceSnapshot: source({
          sku: "2101377120",
          productName: "Антистатическая перчатка",
          category: "宠物用品/宠物护理用品/宠物洗澡海绵",
        }),
      })).resolves.toMatchObject({ typeId: 95236 });
    } finally {
      context.cleanup();
    }
  });

  it("normalizes legacy Seller image metadata before enrichment", () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images);
    try {
      const normalized = module.getSourceFromSnapshot(source({
        images: [{
          id: "string",
          url: "https://cdn.example.com/product.jpg",
          fileName: "",
          mimeType: "",
          byteSize: 0,
          width: 0,
          height: 0,
          source: "source",
        }],
      }), "seller_bridge");
      expect(normalized.images[0]).toMatchObject({ width: 1, height: 1, source: "source" });
      expect(normalized.images[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      context.cleanup();
    }
  });

  it("keeps Seller fields when the target tree cannot resolve type_id", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const storeId = "22222222-2222-4222-8222-222222222222";
    await stores.create({
      id: storeId,
      name: "无法匹配类型的店铺",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("secret", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBO"],
      apiKeyExpiresAt: null,
    });
    const fetchImplementation = (async () => new Response(JSON.stringify({ result: [] }), { status: 200 })) as typeof fetch;
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images, { fetchImplementation });
    try {
      await expect(module.enrichSource({
        storeId,
        sourceType: "seller_bridge",
        sourceSku: "1001",
        sourceSnapshot: source({
          productName: "Seller 商品标题",
          images: [{ id: "", url: "https://example.com/product.jpg", fileName: "product.jpg", mimeType: "image/jpeg", byteSize: 0, width: 0, height: 0, source: "source" }],
        }),
      })).resolves.toMatchObject({
        productName: "Seller 商品标题",
        typeId: null,
        images: [{ url: "https://example.com/product.jpg" }],
        missingFields: ["商品类型 ID"],
      });
    } finally {
      context.cleanup();
    }
  });
});
