(() => {
  "use strict";

  const pendingImports = new Map();

  /** Sends a runtime message without letting a stale extension page script break the UI. */
  function sendExtensionMessage(message, onResponse = () => {}) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        onResponse(response, chrome.runtime.lastError?.message || "");
      });
    } catch (error) {
      onResponse(undefined, error instanceof Error ? error.message : "扩展连接失效");
    }
  }

  function sendReadySources() {
    sendExtensionMessage({ action: "readPending" }, (response, error) => {
      if (error || !response?.ok) return;
      for (const item of response.items || []) {
        window.postMessage({ type: "OZON_GMV_IMPORT_SOURCE", requestId: item.requestId, raw: item.raw }, window.location.origin);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "importOzonProduct") {
      pendingImports.set(message.requestId, sendResponse);
      window.postMessage({ type: "OZON_GMV_IMPORT_SOURCE", requestId: message.requestId, batchId: message.batchId, raw: message.raw }, window.location.origin);
      return true;
    }
    if (message?.action === "batchProgress") {
      window.postMessage({ type: "OZON_GMV_BATCH_PROGRESS", batchId: message.batchId, index: message.index, total: message.total, result: message.result }, window.location.origin);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.action === "batchComplete") {
      window.postMessage({ type: "OZON_GMV_BATCH_COMPLETE", batchId: message.batchId, summary: message.summary }, window.location.origin);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type === "OZON_GMV_IMPORT_READY") sendReadySources();
    if (event.data?.type === "OZON_GMV_START_BATCH_COLLECTION") {
      sendExtensionMessage({ action: "startBatchCollection", batchId: event.data.batchId, urls: event.data.urls }, (response, error) => {
        if (error || !response?.ok) {
          const message = /context invalidated/i.test(error) ? "插件刚更新，请刷新当前 GMV 页面后重试" : error || response?.error || "未检测到采集插件";
          window.postMessage({ type: "OZON_GMV_BATCH_COMPLETE", batchId: event.data.batchId, summary: { saved: 0, complete: 0, incomplete: 0, failed: 0 }, error: message }, window.location.origin);
        } else {
          window.postMessage({ type: "OZON_GMV_BATCH_ACCEPTED", batchId: event.data.batchId, accepted: response.accepted }, window.location.origin);
        }
      });
    }
    if (event.data?.type === "OZON_GMV_SOURCE_COLLECT_RESULT" && event.data.ok && event.data.requestId) {
      sendExtensionMessage({ action: "ackPending", requestId: event.data.requestId });
    }
    if (event.data?.type === "OZON_GMV_SOURCE_COLLECT_RESULT" && event.data.requestId && pendingImports.has(event.data.requestId)) {
      pendingImports.get(event.data.requestId)?.({ ok: Boolean(event.data.ok), error: event.data.error, incompleteFields: event.data.incompleteFields || [] });
      pendingImports.delete(event.data.requestId);
    }
  });
})();
