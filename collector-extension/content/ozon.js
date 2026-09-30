(() => {
  "use strict";
  if (window.__OZON_GMV_PRODUCT_COLLECTOR__) return;
  window.__OZON_GMV_PRODUCT_COLLECTOR__ = true;

  /** Reads structured Ozon product state through the extension's MAIN-world scraper. */
  async function collect() {
    const response = await chrome.runtime.sendMessage({ action: "readProductInPageMainWorld", platform: "ozon" });
    if (!response?.ok || !response.raw) throw new Error(response?.error || "读取 Ozon 商品信息失败");
    return response.raw;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "collectOzonProduct") return false;
    collect()
      .then((raw) => chrome.runtime.sendMessage({ action: "sourceProductCollected", requestId: message.requestId, raw }, (response) => sendResponse({ ok: Boolean(response?.ok) })))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "读取 Ozon 页面失败" }));
    return true;
  });
})();
