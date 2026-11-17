import { AlertTriangle, Code2 } from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { AppNav } from "../components/AppNav";
import { fetchStockPrepAgentApiDocs } from "../api";

/** Presents the live OpenAPI contract for local AI-agent integrations. */
export default function OpenApiDocsPage(): React.JSX.Element {
  const query = useQuery({ queryKey: ["stock-prep-agent-api-docs"], queryFn: fetchStockPrepAgentApiDocs });
  const endpoints = useMemo(() => Object.entries(query.data?.paths ?? {}).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method: method.toUpperCase(), ...operation }))), [query.data]);

  return <div className="admin-page"><a className="skip-link" href="#open-api-main">跳到主要内容</a><header className="admin-header"><a className="brand-lockup" href="/dashboard"><div className="brand-mark" aria-hidden="true">O</div><div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div></a><AppNav/></header><main className="admin-main stock-prep-main" id="open-api-main"><div className="page-title-row"><div><p className="eyebrow">OPEN API</p><h2>开放接口</h2><p>集中查看供外部 AI Agent 与自动化工具调用的接口定义。</p></div></div>
    <section className="settings-card stock-prep-agent-docs"><header><div><p className="eyebrow">LOCAL AI AGENT API</p><h3>{query.data?.info.title ?? "买家黑名单候选接口"}</h3><p>供本机 AI Agent 查询 Ozon 店铺并提交黑名单候选，候选需在 GMV 中人工审核后才会生效。</p></div>{query.data && <span>OpenAPI {query.data.openapi} · v{query.data.info.version}</span>}</header>
      {query.isLoading ? <p>正在加载接口定义…</p> : query.isError ? <div className="field-error">{query.error.message}</div> : <><div className="stock-prep-agent-meta"><div><span>服务地址</span><code>{query.data?.servers[0]?.url}</code></div><div><span>OpenAPI 文档地址</span><code>GET /api/agent/v1/blacklist/openapi.json</code></div></div><div className="stock-prep-agent-notice"><AlertTriangle size={17}/><p>当前接口只接受运行在 GMV 本机的命令行智能体调用。远程智能体不能直接访问本机地址；提交结果只进入“待审核”，不会自动拦截买家。</p></div><div className="stock-prep-agent-endpoints">{endpoints.map((endpoint) => <article key={`${endpoint.method}-${endpoint.path}`}><span>{endpoint.method}</span><code>{endpoint.path}</code><strong>{endpoint.summary}</strong><p>{endpoint.description}</p></article>)}</div><div><h3>调用流程</h3><ol><li>调用店铺列表接口，取得目标 Ozon 店铺的 UUID。</li><li>将买家 ID、命中原因和证据订单提交到候选接口。</li><li>运营人员在 GMV「买家黑名单」中审核并决定是否生效。</li></ol></div><div><h3>请求示例（Windows PowerShell）</h3><pre>{`curl.exe -X PUT "http://127.0.0.1:3001/api/agent/v1/stores/{storeId}/blacklist/candidates" -H "Content-Type: application/json" -d "{\"candidates\":[{\"buyerId\":\"buyer-id\",\"reasonCode\":\"return_abuse\",\"summary\":\"风险说明\",\"evidenceOrders\":[\"订单号\"],\"ruleVersion\":\"v1\"}]}"`}</pre></div></>}
    </section></main></div>;
}
