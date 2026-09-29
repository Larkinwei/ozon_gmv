(() => {
  "use strict";
  if (window.__OZON_GMV_1688_COLLECTOR__) return;
  window.__OZON_GMV_1688_COLLECTOR__ = true;

  const offerId = location.pathname.match(/\/offer\/(\d+)/)?.[1] || "";
  if (!offerId) return;

  function text(selector) {
    return document.querySelector(selector)?.textContent?.trim().replace(/\s+/g, " ") || "";
  }

  function extractImages() {
    const urls = new Set();
    const add = (value) => {
      if (typeof value !== "string" || !/^https?:\/\/(?:(?:cbu\d+|img|gw)\.alicdn\.com|[^/]*1688\.com)\//i.test(value) || /\.svg(?:\?|$)/i.test(value)) return;
      urls.add(value.replace(/_(\d+)x(\d+)q?\d*\.(jpg|jpeg|png|webp).*$/i, ""));
    };
    add(document.querySelector('meta[property="og:image"]')?.content || "");
    document.querySelectorAll('.detail-gallery-img img, .preview-image img, .preview-list img, [class*="gallery"] img, [class*="preview"] img').forEach((image) => {
      add(image.getAttribute("data-original") || image.getAttribute("data-src") || image.src || "");
    });
    return [...urls].slice(0, 20);
  }

  function extractAttributes() {
    const seen = new Set();
    const rows = [];
    document.querySelectorAll('#mod-detail-attributes tr, .detail-attributes tr, [class*="detailAttributes"] li, [class*="attribute-item"], [class*="attr-item"]').forEach((row) => {
      const cells = [...row.querySelectorAll("th, td, .de-feature, .de-value, span")]
        .map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      if (cells.length < 2) return;
      const name = cells[0].replace(/[：:]$/, "").trim();
      const value = cells.slice(1).join(" ").trim();
      const key = `${name}\u0000${value}`;
      if (!name || !value || seen.has(key)) return;
      seen.add(key);
      rows.push({ name, value });
    });
    return rows.slice(0, 80);
  }

  function extractSkuVariants() {
    const seen = new Set();
    const variants = [];
    document.querySelectorAll('#skuSelection .ant-table-tbody tr[data-row-key], .sku-item, [class*="skuItem"], [class*="sku-item"]').forEach((row) => {
      const sourceSkuId = row.getAttribute("data-row-key") || row.getAttribute("data-sku-id") || row.getAttribute("data-skuid") || row.getAttribute("data-id") || "";
      const cells = [...row.querySelectorAll("th, td")].map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      const labelNode = row.querySelector("[title], .sku-item-name, .item-label, .gyp-pro-table-title p");
      const label = (labelNode?.getAttribute("title") || labelNode?.textContent || cells[0] || row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
      const key = sourceSkuId || label;
      if (!label || seen.has(key)) return;
      seen.add(key);

      const image = row.querySelector("img");
      const imageUrl = image?.getAttribute("data-original") || image?.getAttribute("data-src") || image?.src || "";
      const priceText = row.querySelector('[class*="price"], [data-field*="price"]')?.textContent || "";
      const stockText = row.querySelector('[class*="stock"], [class*="amount"], [data-field*="stock"]')?.textContent || "";
      const priceMatch = `${priceText} ${row.textContent || ""}`.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
      const stockMatch = stockText.match(/(\d[\d,]*)/);
      const variantProps = cells.length > 1 ? { specification: cells[0] } : { specification: label };
      variants.push({
        sourceSkuId: sourceSkuId || `dom-${variants.length + 1}`,
        label,
        variantProps,
        price: priceMatch?.[1] || "",
        stock: stockMatch ? Number(stockMatch[1].replace(/,/g, "")) : null,
        inStock: stockMatch ? Number(stockMatch[1].replace(/,/g, "")) > 0 : null,
        imageUrl,
      });
    });
    return variants.slice(0, 100);
  }

  function extractPrice() {
    const value = text(".module-od-main-price, .module-od-price-range, [class*='priceRange']");
    const match = value.replace(/\s+/g, "").match(/[¥￥]?(\d+(?:\.\d{1,2})?)(?:[~至-][¥￥]?(\d+(?:\.\d{1,2})?))?/);
    return match ? { price: match[1], priceRange: match[2] ? `${match[1]}~${match[2]}` : "" } : { price: "", priceRange: "" };
  }

  function collect() {
    const title = text(".title-content, .module-od-title") || document.querySelector('meta[property="og:title"]')?.content || document.title;
    const sellerLink = [...document.querySelectorAll('a[href*=".1688.com"]')].find((link) => /^https?:\/\/shop\d+\.1688\.com\/(\?|$)/i.test(link.href));
    const price = extractPrice();
    return {
      offerId,
      title: title.replace(/\s*[-_|]\s*(阿里巴巴|1688\.com).*$/i, "").trim(),
      mainImages: extractImages(),
      ...price,
      productAttributes: extractAttributes(),
      skuVariants: extractSkuVariants(),
      seller: { name: sellerLink?.textContent?.trim() || "", shopUrl: sellerLink?.href || "" },
      url: location.href.split("#")[0],
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "collect1688Product") return false;
    chrome.runtime.sendMessage({ action: "sourceProductCollected", requestId: message.requestId, raw: collect() }, (response) => {
      sendResponse({ ok: Boolean(response?.ok) });
    });
    return true;
  });

  function toast(message, error = false) {
    const node = document.createElement("div");
    node.textContent = message;
    Object.assign(node.style, { position: "fixed", right: "20px", bottom: "22px", zIndex: "2147483647", padding: "12px 16px", borderRadius: "10px", color: "#fff", background: error ? "#b42318" : "#176b4d", boxShadow: "0 8px 28px #0003", font: "13px system-ui" });
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 4000);
  }

  const button = document.createElement("button");
  button.textContent = "加入 GMV 采集箱";
  Object.assign(button.style, { position: "fixed", right: "22px", bottom: "24px", zIndex: "2147483646", border: "0", borderRadius: "24px", padding: "12px 18px", color: "#fff", background: "#2463eb", boxShadow: "0 5px 16px #1749b955", font: "600 14px system-ui", cursor: "pointer" });
  button.addEventListener("click", async () => {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "发送中…";
    try {
      const response = await chrome.runtime.sendMessage({ action: "collectIntoGmv", raw: collect() });
      if (!response?.ok) throw new Error(response?.error || "发送失败");
      toast("商品已发送，正在打开 GMV 采集箱");
    } catch (error) {
      toast(error?.message || "采集失败", true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  document.body.appendChild(button);
})();
