(() => {
  "use strict";
  if (window.__OZON_GMV_PRODUCT_COLLECTOR__) return;
  window.__OZON_GMV_PRODUCT_COLLECTOR__ = true;

  /** Reads the first non-empty value from JSON-LD product data and Ozon page metadata. */
  function collectProduct() {
    const productNodes = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const nodes = Array.isArray(parsed) ? parsed : parsed?.["@graph"] || [parsed];
        nodes.forEach((node) => {
          if (node && typeof node === "object" && (node["@type"] === "Product" || node.name || node.image)) productNodes.push(node);
        });
      } catch { /* Ignore malformed structured data and continue with page metadata. */ }
    });
    const meta = (selector) => document.querySelector(selector)?.content?.trim() || "";
    const product = productNodes.find((node) => node["@type"] === "Product") || productNodes[0] || {};
    const images = Array.isArray(product.image) ? product.image : product.image ? [product.image] : [];
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
    const rawPrice = String(offer.price || meta('meta[property="product:price:amount"]') || "").replace(",", ".");
    const match = location.pathname.match(/(?:product\/[^/]*-)?(\d{5,})/i);
    const sku = String(product.sku || product.productID || match?.[1] || "").trim();
    return {
      sourceType: "public_page",
      sku,
      title: String(product.name || meta('meta[property="og:title"]') || document.querySelector("h1")?.textContent || "").trim(),
      description: String(product.description || meta('meta[name="description"]') || ""),
      mainImages: [...new Set([...images, meta('meta[property="og:image"]'), ...[...document.querySelectorAll('[class*="gallery"] img')].map((image) => image.currentSrc || image.src)].map((value) => typeof value === "string" ? value : value?.url || "").filter((url) => /^https?:\/\//i.test(url)))].slice(0, 20),
      price: /^\d+(?:\.\d+)?$/.test(rawPrice) ? rawPrice : "",
      currency: String(offer.priceCurrency || meta('meta[property="product:price:currency"]') || "RUB").trim(),
      attributes: Array.isArray(product.additionalProperty) ? Object.fromEntries(product.additionalProperty.filter((item) => item?.name && item?.value).map((item) => [String(item.name), String(item.value)])) : {},
      url: location.href.split("#")[0],
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "collectOzonProduct") return false;
    const raw = collectProduct();
    chrome.runtime.sendMessage({ action: "sourceProductCollected", requestId: message.requestId, raw }, (response) => {
      sendResponse({ ok: Boolean(response?.ok) });
    });
    return true;
  });
})();
