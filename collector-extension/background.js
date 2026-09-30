const PENDING_KEY = "ozon-gmv-collector-pending-v1";
const DASHBOARD_PATTERNS = [
  "http://localhost:5173/*", "http://127.0.0.1:5173/*",
  "http://localhost:3001/*", "http://127.0.0.1:3001/*",
];
const pendingScrapes = new Map();

/** Stores a source snapshot and opens the GMV collection inbox. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "collectIntoGmv") {
    void collectIntoGmv(message.raw).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.action === "startBatchCollection") {
    const dashboardTabId = sender.tab?.id;
    if (!dashboardTabId) { sendResponse({ ok: false, error: "请从 GMV 采集箱提交链接" }); return false; }
    const urls = normalizeSourceUrls(message.urls);
    if (!urls.length || urls.length > 50) { sendResponse({ ok: false, error: "没有有效的 Ozon 或 1688 商品链接，单次最多 50 条" }); return false; }
    sendResponse({ ok: true, accepted: urls.length });
    void processBatchCollection(message.batchId, urls, dashboardTabId);
    return false;
  }
  if (message?.action === "sourceProductCollected") {
    const pending = pendingScrapes.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingScrapes.delete(message.requestId);
      pending.resolve(message.raw);
    }
    sendResponse({ ok: Boolean(pending) });
    return false;
  }
  if (message?.action === "readProductInPageMainWorld") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "无法访问商品页面" }); return false; }
    void readProductInPageMainWorld(tabId, message.platform).then((raw) => sendResponse({ ok: true, raw })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "商品信息读取失败" }));
    return true;
  }
  if (message?.action === "readPending") {
    chrome.storage.local.get(PENDING_KEY, (value) => sendResponse({ ok: true, items: value[PENDING_KEY] || [] }));
    return true;
  }
  if (message?.action === "ackPending") {
    void acknowledge(message.requestId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "openCollectionInbox") {
    void openCollectionInbox().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

/** Runs extraction beside marketplace page scripts so runtime product state is readable. */
async function readProductInPageMainWorld(tabId, platform) {
  if (platform !== "1688" && platform !== "ozon") throw new Error("暂不支持该商品来源");
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: collectMarketplaceProduct, args: [platform] });
  const raw = results[0]?.result;
  if (!raw || !raw.title) throw new Error("未读取到商品标题，请确认商品详情已加载");
  return raw;
}

/** Extracts marketplace runtime data and supplements it with visible DOM fields. */
async function collectMarketplaceProduct(platform) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const has1688Model = window.context?.result?.global?.globalData?.model || window.__INIT_DATA?.globalData;
    const model = has1688Model?.model || has1688Model;
    const skuInfoMap = model?.skuModel?.skuInfoMap;
    const skuMap = model?.tradeModel?.skuMap;
    const has1688Variants = (Array.isArray(skuMap) && skuMap.length > 0) || Boolean(skuMap && typeof skuMap === "object" && Object.keys(skuMap).length > 0) || Boolean(skuInfoMap && typeof skuInfoMap === "object" && Object.keys(skuInfoMap).length > 0);
    const hasVisibleProduct = Boolean(document.querySelector("h1, .title-content, .module-od-title") && document.querySelector("#gallery img, [data-module=\"od_picture_gallery\"] img, [class*=gallery] img"));
    const hasVisibleVariants = Boolean(document.querySelector("[class*=skuItem], [class*=sku-item], [class*=variant], #skuSelection tr[data-row-key]"));
    let hasStructuredOzonOffers = false;
    if (platform === "ozon") document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const value = JSON.parse(script.textContent || "null");
        const nodes = Array.isArray(value) ? value : Array.isArray(value?.["@graph"]) ? value["@graph"] : [value];
        if (nodes.some((node) => node?.offers && (Array.isArray(node.offers) ? node.offers.length > 0 : true))) hasStructuredOzonOffers = true;
      } catch { /* Ignore malformed structured data while the product page loads. */ }
    });
    const detailsReady = platform === "1688" ? has1688Variants : hasVisibleVariants || hasStructuredOzonOffers;
    if (hasVisibleProduct && detailsReady) break;
    await pause(200);
  }
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const objectOf = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const roots = [window.__INIT_DATA, window.context, window.iDetailData, window.offerDetailData, window.__INITIAL_STATE__, window.__NUXT__];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try { roots.push(JSON.parse(script.textContent || "null")); } catch { /* Ignore unrelated malformed JSON-LD. */ }
  });
  let objects = [];
  const seenObjects = new WeakSet();
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 14 || objects.length >= 18000 || seenObjects.has(value)) return;
    seenObjects.add(value);
    objects.push(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  }
  roots.forEach((root) => walk(root));
  const findByKey = (key) => objects.find((item) => item[key] !== undefined && item[key] !== null)?.[key];
  const normalizeUrl = (value) => {
    const candidate = typeof value === "string" ? value : value?.url || value?.src || value?.imageUrl || value?.imageURI || value?.fullPathImageURI || "";
    if (typeof candidate !== "string" || !candidate.trim()) return "";
    let url = candidate.trim().replace(/^\/\//, "https://");
    url = url.replace(/\.(jpe?g|png|webp|gif)_(?:\.webp|b\.\1|sum\.\1)(?=($|[?#]))/i, ".$1");
    return /^https?:\/\//i.test(url) && !/\.svg(?:[?#]|$)/i.test(url) ? url : "";
  };
  const dedupe = (items) => [...new Set(items.filter(Boolean))];
  const productIdMatch = location.pathname.match(/\/offer\/(\d+)/);
  const ozonIdMatch = location.pathname.match(/(?:product\/[^/]*-)?(\d{5,})/i);
  const offerId = platform === "1688" ? productIdMatch?.[1] || new URL(location.href).searchParams.get("offerId") || "" : ozonIdMatch?.[1] || "";
  const contextModel = window.context?.result?.global?.globalData?.model || window.__INIT_DATA?.globalData?.model || window.__INIT_DATA?.globalData || {};
  const offerBase = contextModel.offerBaseInfo || {};
  const tradeModel = contextModel.tradeModel || {};
  const skuModel = contextModel.skuModel || {};
  const titleNode = document.querySelector("h1, .title-content, .module-od-title");
  const schemaProduct = objects.find((item) => item["@type"] === "Product") || {};
  const title = clean((platform === "1688" ? offerBase.subject || offerBase.title : schemaProduct.name) || findByKey("subject") || findByKey("productTitle") || titleNode?.textContent || document.querySelector('meta[property="og:title"]')?.content || document.title).replace(/\s*[-_|]\s*(阿里巴巴|1688\.com).*$/i, "");
  const imageValues = [];
  function appendImages(value) {
    if (Array.isArray(value)) value.forEach(appendImages);
    else { const url = normalizeUrl(value); if (url) imageValues.push(url); }
  }
  if (platform === "1688") {
    appendImages(offerBase.mainImageList);
    appendImages(window.context?.result?.data?.gallery?.fields?.mainImageList);
    appendImages(window.context?.result?.data?.gallery?.fields?.imageList);
    appendImages(window.context?.result?.data?.gallery?.fields?.images);
    document.querySelectorAll('#gallery .od-gallery-turn-item-wrapper img.od-gallery-img, [data-module="od_picture_gallery"] .od-gallery-turn-item-wrapper img.od-gallery-img, .module-od-picture-gallery .od-gallery-turn-item-wrapper img.od-gallery-img, #gallery img.preview-img, #gallery img, [data-module="od_picture_gallery"] img, .module-od-picture-gallery img').forEach((image) => appendImages(image.getAttribute("data-src") || image.getAttribute("src") || image.currentSrc || image.src));
    document.querySelectorAll('#gallery [style*="background-image"], [data-module="od_picture_gallery"] [style*="background-image"]').forEach((node) => {
      const match = (node.getAttribute("style") || "").match(/url\(["']?(.*?)["']?\)/i);
      if (match?.[1]) appendImages(match[1]);
    });
  }
  objects.forEach((item) => {
    for (const key of ["mainImageList", "imageList", "main_images", "mainImages", "images", "primary_image", "image", "picUrl"]) appendImages(item[key]);
  });
  document.querySelectorAll('meta[property="og:image"], [class*="gallery"] img, [class*="preview"] img').forEach((image) => appendImages(image.content || image.getAttribute("data-src") || image.getAttribute("data-original") || image.currentSrc || image.src));
  const mainImages = dedupe(imageValues).slice(0, 40);
  const attributes = new Map();
  const attributeRows = [window.context?.result?.data?.productAttributes?.fields?.attributes, contextModel.offerAttributeModel?.offerAttrs, window.__INIT_DATA?.globalData?.offerAttributeModel?.offerAttrs].find(Array.isArray) || [];
  for (const item of attributeRows) {
    const name = clean(item?.name || item?.attrName || item?.title || item?.key);
    const value = clean(item?.value || item?.attrValue || item?.content || item?.text);
    if (name && value) attributes.set(name, value);
  }
  document.querySelectorAll('[data-module="od_product_attributes"] tr, .module-od-product-attributes tr, #mod-detail-attributes tr, .detail-attributes tr').forEach((row) => {
    const cells = [...row.querySelectorAll("th,td")].map((cell) => clean(cell.textContent)).filter(Boolean);
    if (cells.length >= 2) attributes.set(cells[0].replace(/[：:]$/, ""), cells.slice(1).join(" "));
  });
  const variantImagesByLabel = new Map();
  const skuProps = Array.isArray(skuModel.skuProps) ? skuModel.skuProps : Array.isArray(contextModel.skuProps) ? contextModel.skuProps : [];
  skuProps.forEach((property) => (Array.isArray(property?.value) ? property.value : []).forEach((value) => {
    const label = clean(value?.name || value?.value || value?.displayName || value?.text);
    const image = normalizeUrl(value?.imageUrl || value?.imgUrl || value?.image || value?.fullPathImageURI || value?.size310x310ImageURI);
    if (label && image) variantImagesByLabel.set(label.toLowerCase(), image);
  }));
  const variants = [];
  const variantsBySkuId = new Map();
  const variantsByLabel = new Map();
  // 1688's piece-weight table provides each SKU's dimensions in cm and weight in g.
  const weightScale = contextModel.detailDescription?.pieceWeightScale || findByKey("pieceWeightScale");
  const dimensionRows = Array.isArray(weightScale?.pieceWeightScaleInfo) ? weightScale.pieceWeightScaleInfo : [];
  const dimensionsBySkuId = new Map();
  const dimensionsByLabel = new Map();
  for (const item of dimensionRows) {
    const skuId = clean(item?.skuId);
    const label = clean(item?.sku1 || item?.sku2 || item?.sku3);
    const dimensions = {
      depth: item?.length,
      width: item?.width,
      height: item?.height,
      weight: item?.weight,
    };
    if (skuId) dimensionsBySkuId.set(skuId, dimensions);
    if (label) dimensionsByLabel.set(label.toLowerCase(), dimensions);
  }
  const normalizeVariantLabel = (value) => clean(value).replace(/^(?:商品规格|规格)\s*[：:]\s*/, "").toLowerCase();
  const measurementText = (value, multiplier = 1) => {
    const number = Number(clean(value));
    return Number.isFinite(number) && number > 0 ? String(number * multiplier) : "";
  };
  function dimensionsFor(skuId, label) {
    const source = dimensionsBySkuId.get(skuId) || dimensionsByLabel.get(normalizeVariantLabel(label));
    return {
      depth: measurementText(source?.depth, 10),
      width: measurementText(source?.width, 10),
      height: measurementText(source?.height, 10),
      dimensionUnit: "mm",
      weight: measurementText(source?.weight),
      weightUnit: "g",
    };
  }
  function addVariant(row, fallbackId = "") {
    if (!objectOf(row)) return;
    const rawProps = row.specAttrs || row.specAttr || row.spec || row.specs || row.properties || row.variant_props || {};
    const props = objectOf(rawProps) || {};
    const label = clean(typeof rawProps === "string" ? rawProps : Object.entries(props).map(([key, value]) => `${key}: ${typeof value === "object" ? value?.value || value?.name || "" : value}`).filter((part) => !part.endsWith(": ")).join(" / ") || row.skuName || row.name || row.label || row.title);
    const sourceSkuId = clean(row.skuId || row.sku_id || row.source_sku_id || row.id || row.specId || fallbackId);
    if (!sourceSkuId && !label) return;
    const rawPrice = row.price ?? row.discountPrice ?? row.currentPrice ?? row.priceDisplay ?? row.salePrice ?? row.priceInfo?.price ?? row.priceInfo?.promotionPrice ?? "";
    const priceText = clean(rawPrice).replace(/[¥￥,]/g, "");
    const price = /^\d+(?:\.\d+)?$/.test(priceText) ? priceText : "";
    const rawStock = row.canBookCount ?? row.canBookedAmount ?? row.amountOnSale ?? row.stock ?? row.quantity ?? row.inventory;
    const stockNumber = rawStock === "" || rawStock === null || rawStock === undefined ? null : Number(String(rawStock).replace(/,/g, ""));
    const imageUrl = normalizeUrl(row.imageUrl || row.imgUrl || row.sku_image || row.skuImage || row.image || row.specImage) || variantImagesByLabel.get(label.toLowerCase()) || "";
    const stock = Number.isInteger(stockNumber) && stockNumber >= 0 ? stockNumber : null;
    const packageDimensions = dimensionsFor(sourceSkuId, label);
    const normalizedLabel = normalizeVariantLabel(label);
    const existing = (sourceSkuId && variantsBySkuId.get(sourceSkuId)) || (normalizedLabel && variantsByLabel.get(normalizedLabel));
    if (existing) {
      if (!existing.sourceSkuId && sourceSkuId) {
        existing.sourceSkuId = sourceSkuId;
        variantsBySkuId.set(sourceSkuId, existing);
      }
      if (!existing.price) existing.price = price;
      if (existing.stock === null) existing.stock = stock;
      if (!existing.imageUrl) existing.imageUrl = imageUrl;
      if (Object.keys(existing.variantProps).length === 0) existing.variantProps = props;
      for (const field of ["depth", "width", "height", "weight"]) {
        if (!existing.packageDimensions[field]) existing.packageDimensions[field] = packageDimensions[field];
      }
      return;
    }
    const variant = { sourceSkuId, label, variantProps: props, price, stock, imageUrl, packageDimensions };
    variants.push(variant);
    if (sourceSkuId) variantsBySkuId.set(sourceSkuId, variant);
    if (normalizedLabel) variantsByLabel.set(normalizedLabel, variant);
  }
  if (platform === "1688") {
    const skuMap = tradeModel.skuMap;
    if (Array.isArray(skuMap)) skuMap.forEach((row) => addVariant(row));
    else Object.entries(objectOf(skuMap) || {}).forEach(([key, row]) => addVariant(row, key));
    Object.entries(objectOf(skuModel.skuInfoMap) || {}).forEach(([key, row]) => addVariant(row, key));
  }
  if (platform === "ozon") {
    for (const object of objects) {
      const rows = [object.skuList, object.skuMap, object.skuInfoList, object.skuItems, object.variants, object.offers].find(Array.isArray);
      rows?.forEach((row) => addVariant(row));
    }
  }
  const selectors = platform === "1688" ? '#skuSelection .ant-table-tbody tr[data-row-key], #skuSelection .expand-view-item, .sku-item, [class*="skuItem"], [class*="sku-item"]' : '[class*="skuItem"], [class*="sku-item"], [class*="variant"]';
  document.querySelectorAll(selectors).forEach((row) => {
    const cells = [...row.querySelectorAll("th,td")].map((cell) => clean(cell.textContent)).filter(Boolean);
    const labelNode = row.querySelector(".gyp-pro-table-title p, .item-label, [title], [class*='name']");
    const label = clean(labelNode?.getAttribute("title") || labelNode?.textContent || cells[0]);
    const sourceSkuId = clean(row.getAttribute("data-row-key") || row.getAttribute("data-sku-id") || row.getAttribute("data-skuid"));
    const priceNode = row.querySelector(".gyp-pro-table-price span, [class*='price'], [data-field*='price']");
    const stockNode = row.querySelector(".gyp-pro-table-price span:nth-child(2), [class*='stock'], [class*='amount'], [data-field*='stock']");
    const priceMatch = clean(priceNode?.textContent).match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
    const stockMatch = clean(stockNode?.textContent).match(/(\d[\d,]*)/);
    addVariant({ sourceSkuId, label, specAttrs: { 商品规格: label }, price: priceMatch?.[1] || "", stock: stockMatch ? Number(stockMatch[1].replace(/,/g, "")) : null, imageUrl: row.querySelector("img")?.currentSrc || row.querySelector("img")?.src || "" });
  });
  const schemaOffer = Array.isArray(schemaProduct.offers) ? schemaProduct.offers[0] : schemaProduct.offers || {};
  const rawPrice = platform === "1688" ? tradeModel.minPrice || tradeModel.priceDisplay || "" : schemaOffer.price || findByKey("price") || document.querySelector('meta[property="product:price:amount"]')?.content || "";
  const priceText = clean(rawPrice).replace(/[¥￥,]/g, "");
  const priceMatch = priceText.match(/\d+(?:\.\d+)?/);
  const priceRange = platform === "1688" ? (tradeModel.minPrice && tradeModel.maxPrice ? `${tradeModel.minPrice}~${tradeModel.maxPrice}` : "") : "";
  const descriptionImages = dedupe([...document.querySelectorAll('[class*="detail"] img, [class*="description"] img, .detail-content img')].map((image) => normalizeUrl(image.getAttribute("data-src") || image.getAttribute("data-lazyload-src") || image.currentSrc || image.src))).slice(0, 60);
  const videos = dedupe([...document.querySelectorAll("video[src],video source[src]")].map((video) => video.src).filter((url) => /^https?:\/\//i.test(url))).slice(0, 10);
  const missingFields = [];
  if (!offerId) missingFields.push("商品编号");
  if (!title) missingFields.push("商品标题");
  if (!mainImages.length) missingFields.push("商品图片");
  if (!variants.length) missingFields.push("SKU 规格");
  if (variants.some((variant) => !variant.price)) missingFields.push("SKU 价格");
  if (variants.some((variant) => variant.stock === null)) missingFields.push("SKU 库存");
  if (platform === "1688" && variants.some((variant) => !variant.packageDimensions.depth || !variant.packageDimensions.width || !variant.packageDimensions.height || !variant.packageDimensions.weight)) missingFields.push("SKU 尺寸/重量");
  if (!attributes.size) missingFields.push("商品属性");
  return {
    sourceType: platform === "1688" ? "1688_collector" : "public_page",
    offerId,
    sku: offerId,
    title,
    description: clean(schemaProduct.description || findByKey("description") || document.querySelector('meta[name="description"]')?.content),
    mainImages,
    descriptionImages,
    videos,
    price: variants.find((variant) => variant.price)?.price || priceMatch?.[0] || "",
    priceRange,
    currency: platform === "1688" ? "CNY" : clean(findByKey("priceCurrency") || document.querySelector('meta[property="product:price:currency"]')?.content || "RUB"),
    productAttributes: [...attributes].map(([name, value]) => ({ name, value })),
    attributes: Object.fromEntries(attributes),
    skuVariants: variants.slice(0, 100),
    missingFields: [...new Set(missingFields)],
    sourceDiagnostics: { extractor: `${platform}-main-world+structured-data+dom`, collectedAt: new Date().toISOString(), structuredObjectCount: objects.length, skuCount: variants.length, warnings: [...new Set(missingFields)] },
    url: location.href.split("#")[0],
  };
}

/** Accepts public Ozon product pages and 1688 offer detail pages. */
function normalizeSourceUrls(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => {
    try {
      const url = new URL(String(value));
      const ozonProduct = ["ozon.ru", "www.ozon.ru"].includes(url.hostname) && url.pathname.includes("/product/");
      const alibabaOffer = url.hostname === "detail.1688.com" && /^\/offer\/\d+/.test(url.pathname);
      return url.protocol === "https:" && (ozonProduct || alibabaOffer) ? url.href : "";
    } catch { return ""; }
  }).filter(Boolean))];
}

/** Scrapes each product in a background tab and waits for GMV persistence before continuing. */
async function processBatchCollection(batchId, urls, dashboardTabId) {
  let saved = 0;
  let complete = 0;
  let incomplete = 0;
  let failed = 0;
  for (let index = 0; index < urls.length; index += 1) {
    let productTabId;
    let result = { ok: false, error: "采集失败" };
    try {
      const requestId = crypto.randomUUID();
      const product = await new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingScrapes.delete(requestId);
          reject(new Error("商品页未能返回数据"));
        }, 45000);
        pendingScrapes.set(requestId, { resolve, reject, timeout });
        try {
          const tab = await chrome.tabs.create({ url: urls[index], active: false });
          if (!tab.id) throw new Error("无法打开商品页");
          productTabId = tab.id;
          const waitForContent = setInterval(() => {
            const action = new URL(urls[index]).hostname === "detail.1688.com" ? "collect1688Product" : "collectOzonProduct";
            chrome.tabs.sendMessage(productTabId, { action, requestId }, () => {
              if (chrome.runtime.lastError) return;
              clearInterval(waitForContent);
            });
          }, 1200);
          setTimeout(() => clearInterval(waitForContent), 15000);
        } catch (error) {
          clearTimeout(timeout);
          pendingScrapes.delete(requestId);
          reject(error);
        }
      });
      const imported = await chrome.tabs.sendMessage(dashboardTabId, { action: "importOzonProduct", batchId, requestId: crypto.randomUUID(), raw: product });
      result = imported?.ok
        ? { ok: true, incompleteFields: Array.isArray(imported.incompleteFields) ? imported.incompleteFields : [] }
        : { ok: false, error: imported?.error || "GMV 保存失败" };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "采集失败" };
    } finally {
      if (productTabId) await chrome.tabs.remove(productTabId).catch(() => {});
      if (result.ok) {
        saved += 1;
        if (result.incompleteFields.length) incomplete += 1;
        else complete += 1;
      } else {
        failed += 1;
      }
      await sendBatchEvent(dashboardTabId, { action: "batchProgress", batchId, index: index + 1, total: urls.length, result });
    }
  }
  await sendBatchEvent(dashboardTabId, { action: "batchComplete", batchId, summary: { saved, complete, incomplete, failed } });
}

/** Sends progress events to the GMV tab without taking focus away from it. */
async function sendBatchEvent(tabId, message) {
  if (!tabId) return;
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function collectIntoGmv(raw) {
  const offerId = String(raw?.offerId || "").trim();
  if (!offerId || !String(raw?.title || "").trim()) throw new Error("缺少商品编号或标题");
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pending = Array.isArray(stored[PENDING_KEY]) ? stored[PENDING_KEY] : [];
  pending.push({ requestId: crypto.randomUUID(), raw, createdAt: Date.now() });
  await chrome.storage.local.set({ [PENDING_KEY]: pending.slice(-20) });

  const tabs = await chrome.tabs.query({ url: DASHBOARD_PATTERNS });
  const origin = tabs[0]?.url ? new URL(tabs[0].url).origin : "http://127.0.0.1:5173";
  const tab = await chrome.tabs.create({ url: `${origin}/operations/publish/collection`, active: true });
  if (!tab.id) throw new Error("无法打开 GMV 工作台");
  return { ok: true };
}

async function acknowledge(requestId) {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pending = Array.isArray(stored[PENDING_KEY]) ? stored[PENDING_KEY] : [];
  await chrome.storage.local.set({ [PENDING_KEY]: pending.filter((item) => item.requestId !== requestId) });
}

/** Focuses the existing local collection inbox or opens it in a new tab. */
async function openCollectionInbox() {
  const tabs = await chrome.tabs.query({ url: DASHBOARD_PATTERNS });
  const tab = tabs.find((item) => item.url && /^https?:\/\/(?:localhost|127\.0\.0\.1):3001\//.test(item.url)) || tabs[0];
  const origin = tab?.url ? new URL(tab.url).origin : "http://127.0.0.1:3001";
  const url = `${origin}/operations/publish/collection`;
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url, active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}
