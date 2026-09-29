const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const statusDot = document.querySelector(".status-dot");
const captureButton = document.getElementById("capture");
const errorMessage = document.getElementById("error");
let activeTabId = null;

/** Shows whether the active tab is a supported 1688 product detail page. */
async function loadActiveProduct() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDetail = Boolean(tab?.id && /^https:\/\/detail\.1688\.com\/offer\//i.test(tab.url || ""));
  activeTabId = isDetail ? tab.id : null;
  captureButton.disabled = !isDetail;
  statusDot.classList.toggle("is-ready", isDetail);
  if (!isDetail) {
    statusTitle.textContent = "当前页面不是 1688 商品详情";
    statusDetail.textContent = "打开 detail.1688.com 的商品页后即可采集。";
    return;
  }
  try {
    const product = await chrome.tabs.sendMessage(tab.id, { action: "getCurrent1688Product" });
    statusTitle.textContent = product?.title || "已识别 1688 商品详情页";
    statusDetail.textContent = product?.offerId ? `商品编号：${product.offerId}` : "等待页面商品信息加载";
  } catch {
    captureButton.disabled = true;
    statusTitle.textContent = "插件尚未连接到当前页面";
    statusDetail.textContent = "刷新 1688 商品详情页后重试。";
    showError("如果刚安装或更新插件，请刷新当前 1688 页面再采集。");
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

captureButton.addEventListener("click", async () => {
  if (!activeTabId) return;
  captureButton.disabled = true;
  captureButton.textContent = "正在采集…";
  errorMessage.hidden = true;
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, { action: "captureCurrent1688Product" });
    if (!result?.ok) throw new Error(result?.error || "采集失败");
    statusTitle.textContent = "已发送到 GMV 采集箱";
    statusDetail.textContent = "数据持久化后会从插件待发送队列移除。";
    setTimeout(() => window.close(), 800);
  } catch (error) {
    showError(error instanceof Error ? error.message : "采集失败，请刷新页面重试。");
    captureButton.disabled = false;
    captureButton.textContent = "采集当前商品";
  }
});

document.getElementById("open-inbox").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ action: "openCollectionInbox" });
  if (!result?.ok) showError(result?.error || "无法打开 GMV 采集箱");
  else window.close();
});
void loadActiveProduct();
