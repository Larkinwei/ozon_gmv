import { Download, Puzzle } from "lucide-react";
import "./PublishCollectionPage.css";

/** Provides the packaged GMV collector and its local Chrome installation steps. */
export default function CollectorExtensionPage(): React.JSX.Element {
  return (
    <main className="admin-main selection-main">
      <header className="resell-heading"><div><p className="eyebrow">GMV COLLECTOR · BETA</p><h1>商品采集插件</h1><p>在采集箱粘贴 Ozon 或 1688 商品链接，插件会逐条采集并创建草稿。</p></div><Puzzle size={32} aria-hidden="true" /></header>
      <section className="publish-draft-panel collector-extension-panel">
        <div className="collector-extension-download"><span className="collector-extension-icon"><Puzzle size={25} /></span><div><strong>Ozon GMV 商品采集助手</strong><small>版本 0.2.3 · Chrome · 支持 Ozon 和 1688 商品链接批量采集</small></div><a className="primary-button" href="/downloads/ozon-gmv-collector-v0.2.3.zip" download><Download size={16} />下载插件 ZIP</a></div>
        <ol className="collector-extension-steps"><li><strong>下载并解压</strong><span>把 ZIP 解压到本机一个固定文件夹。</span></li><li><strong>打开 Chrome 扩展管理</strong><span>访问 <code>chrome://extensions</code> 并打开“开发者模式”。</span></li><li><strong>加载或刷新扩展</strong><span>新装选择“加载已解压的扩展程序”；已安装用户在扩展卡片点刷新图标，然后刷新 GMV 页面连接新版插件。</span></li><li><strong>粘贴链接采集</strong><span>回到 GMV 采集箱，点击“一键采集”，粘贴 Ozon 或 1688 商品链接后提交。商品页会在后台逐个读取，GMV 保存成功后计入结果。</span></li></ol>
        <div className="collector-extension-actions"><a className="secondary-button" href="/operations/publish/collection">返回采集箱</a></div>
        <p className="collector-extension-note">插件负责读取公开商品页中的标题、图片、价格和可见属性；页面缺失的信息会留空，草稿仍需运营补充目标类目、包装尺寸和 Ozon 必填属性后预检发布。1688 详情页采集仍可作为扩展能力使用，但不是采集箱的主入口。</p>
      </section>
    </main>
  );
}
