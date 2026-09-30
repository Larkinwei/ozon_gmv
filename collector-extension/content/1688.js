(() => {
  "use strict";
  if (window.__OZON_GMV_1688_COLLECTOR__) return;
  window.__OZON_GMV_1688_COLLECTOR__ = true;

  const offerId = location.pathname.match(/\/offer\/(\d+)/)?.[1] || "";
  if (!offerId) return;

  /** Reads structured 1688 product state through the extension's MAIN-world scraper. */
  async function collect() {
    const response = await chrome.runtime.sendMessage({ action: "readProductInPageMainWorld", platform: "1688" });
    if (!response?.ok || !response.raw) throw new Error(response?.error || "读取 1688 商品信息失败");
    return response.raw;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "collect1688Product") return false;
    collect()
      .then((raw) => chrome.runtime.sendMessage({ action: "sourceProductCollected", requestId: message.requestId, raw }, (response) => sendResponse({ ok: Boolean(response?.ok) })))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "读取 1688 页面失败" }));
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
    try {
      const raw = await collect();
      const response = await chrome.runtime.sendMessage({ action: "collectIntoGmv", raw });
      if (!response?.ok) throw new Error(response?.error || "发送失败");
      toast(raw.missingFields.length ? `已发送到采集箱，待补：${raw.missingFields.join("、")}` : "商品信息已发送到 GMV 采集箱");
    } catch (error) { toast(error?.message || "采集失败", true); }
    finally { button.disabled = false; }
  });
  document.body.appendChild(button);
})();
