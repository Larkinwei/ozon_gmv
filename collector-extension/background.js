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
  let success = 0;
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
      result = imported?.ok ? { ok: true } : { ok: false, error: imported?.error || "GMV 保存失败" };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "采集失败" };
    } finally {
      if (productTabId) await chrome.tabs.remove(productTabId).catch(() => {});
      if (result.ok) success += 1; else failed += 1;
      await sendBatchEvent(dashboardTabId, { action: "batchProgress", batchId, index: index + 1, total: urls.length, result });
    }
  }
  await sendBatchEvent(dashboardTabId, { action: "batchComplete", batchId, summary: { success, failed } });
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
