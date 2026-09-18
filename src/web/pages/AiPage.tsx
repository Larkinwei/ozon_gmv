import { Copy, LoaderCircle, MessageSquarePlus, RefreshCw, Send, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AiApplicationView, AiConversationRunStatus, AiConversationStreamEvent, AiConversationView, AiMessageView, AiProductContext, AiProductSourceView, AiPromptCandidate } from "../../shared/contracts";
import { ApiRequestError, createAiConversation, fetchAiApplications, fetchAiConversation, fetchAiConversations, fetchAiRelayStatus, fetchAiSources, streamAiConversationMessage } from "../api";

const emptyContext: AiProductContext = { name: "", category: "", attributes: {}, material: "", color: "", targetMarket: "俄罗斯", imagePurpose: "场景图", style: "真实电商摄影", aspectRatio: "1:1" };

interface StreamingMessageState {
  text: string;
  status: "thinking" | "streaming";
}

function CandidateCard({ candidate }: { candidate: AiPromptCandidate }): React.JSX.Element {
  const [prompt, setPrompt] = useState(candidate.prompt);
  const [copied, setCopied] = useState(false);

  async function copyPrompt(): Promise<void> {
    await navigator.clipboard.writeText(`${prompt}\n\nNegative prompt: ${candidate.negativePrompt}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return <article className="ai-candidate-card">
    <div className="ai-candidate-heading"><strong>候选方案</strong><button className="secondary-button" type="button" onClick={() => void copyPrompt()}><Copy size={14} aria-hidden="true" />{copied ? "已复制" : "复制"}</button></div>
    <label className="ai-field"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /></label>
    <dl className="ai-candidate-facts">
      <div><dt>Negative prompt</dt><dd>{candidate.negativePrompt}</dd></div>
      <div><dt>构图 / 灯光</dt><dd>{candidate.composition} · {candidate.lighting}</dd></div>
      <div><dt>背景 / 风格</dt><dd>{candidate.background} · {candidate.style}</dd></div>
      <div><dt>商品保护</dt><dd>{candidate.subjectProtection.join("；")}</dd></div>
    </dl>
  </article>;
}

function Message({ message }: { message: AiMessageView }): React.JSX.Element {
  const isUser = message.role === "user";
  return <article className={`ai-message ai-message--${message.role}`}>
    {!isUser && <span className="ai-message-role">AI</span>}
    <div className="ai-message-body">
      {"text" in message.content ? <p className="ai-message-text">{message.content.text}</p> : <div className="ai-candidates">{message.content.candidates.map((candidate, index) => <CandidateCard candidate={candidate} key={`${message.id}-${index}`} />)}</div>}
    </div>
    {isUser && <span className="ai-message-role">你</span>}
  </article>;
}

function StreamingMessage({ message }: { message: StreamingMessageState }): React.JSX.Element {
  return <article className="ai-message ai-message--assistant ai-message--streaming">
    <span className="ai-message-role">AI</span>
    <div className="ai-message-body">
      {message.status === "thinking" && !message.text ? <div className="ai-thinking" role="status"><LoaderCircle className="ai-thinking-icon" size={17} aria-hidden="true" /><span>正在思考</span><span className="ai-thinking-dots" aria-hidden="true"><i /><i /><i /></span></div> : <p className="ai-message-text">{message.text}<span className="ai-streaming-cursor" aria-hidden="true" /></p>}
    </div>
  </article>;
}

function runStatusLabel(status: AiConversationRunStatus): string {
  if (status === "submitted") return "正在思考";
  if (status === "streaming") return "正在生成";
  if (status === "aborted") return "已停止";
  if (status === "error") return "生成失败";
  return "";
}

/** Provides the AI application registry, streaming chat and product context editor. */
export default function AiPage(): React.JSX.Element {
  const [applications, setApplications] = useState<AiApplicationView[]>([]);
  const [conversations, setConversations] = useState<AiConversationView[]>([]);
  const [sources, setSources] = useState<AiProductSourceView[]>([]);
  const [conversation, setConversation] = useState<AiConversationView | null>(null);
  const [context, setContext] = useState<AiProductContext>(emptyContext);
  const [sourceId, setSourceId] = useState("");
  const [selectedApplicationId, setSelectedApplicationId] = useState("product-image-prompt");
  const [message, setMessage] = useState("");
  const [lastRequest, setLastRequest] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatStatus, setChatStatus] = useState<AiConversationRunStatus>("idle");
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const shouldAutoScrollRef = useRef(true);
  const enabledApplications = useMemo(() => applications.filter((item) => item.status === "enabled"), [applications]);
  const selectedApplication = applications.find((item) => item.id === selectedApplicationId && item.status === "enabled") ?? enabledApplications[0];
  const isSending = chatStatus === "submitted" || chatStatus === "streaming";

  useEffect(() => {
    void Promise.all([fetchAiApplications(), fetchAiConversations(), fetchAiRelayStatus(), fetchAiSources()]).then(([apps, history, relay, sourceResult]) => {
      setApplications(apps.applications);
      if (apps.applications.some((item) => item.id === "product-image-prompt" && item.status === "enabled")) setSelectedApplicationId("product-image-prompt");
      setConversations(history);
      setRelayAvailable(relay.available);
      setSources(sourceResult.sources);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "AI 工作台加载失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const element = messageListRef.current;
    if (element && shouldAutoScrollRef.current) element.scrollTop = element.scrollHeight;
  }, [conversation?.messages.length, streamingMessage?.text, chatStatus]);

  function updateContext<K extends keyof AiProductContext>(key: K, value: AiProductContext[K]): void {
    setContext((current) => ({ ...current, [key]: value }));
    if (conversation) setConversation((current) => current ? { ...current, productContext: { ...current.productContext, [key]: value } } : current);
  }

  function selectSource(value: string): void {
    setSourceId(value);
    if (!value) { setContext(emptyContext); return; }
    const source = sources.find((item) => item.id === value);
    if (source) setContext(source.productContext);
  }

  function stopActiveRequest(): void {
    requestSequenceRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setChatStatus("aborted");
  }

  function startNewConversation(): void {
    stopActiveRequest();
    setConversation(null);
    setContext(emptyContext);
    setError(null);
    setMessage("");
    setLastRequest(null);
    setStreamingMessage(null);
    setChatStatus("idle");
    setSourceId("");
  }

  async function selectConversation(id: string): Promise<void> {
    stopActiveRequest();
    try {
      const selected = await fetchAiConversation(id);
      setConversation(selected);
      setSelectedApplicationId(selected.applicationId);
      setContext(selected.productContext);
      setSourceId("");
      setStreamingMessage(null);
      setChatStatus("idle");
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开对话"); }
  }

  function updateConversation(next: AiConversationView): void {
    setConversation(next);
    setConversations((items) => [next, ...items.filter((item) => item.id !== next.id)]);
  }

  function handleStreamEvent(token: number, event: AiConversationStreamEvent): void {
    if (token !== requestSequenceRef.current) return;
    if (event.type === "run_started") {
      setChatStatus("submitted");
    } else if (event.type === "status") {
      setChatStatus("submitted");
      setStreamingMessage((current) => current ?? { text: "", status: "thinking" });
    } else if (event.type === "delta") {
      setChatStatus("streaming");
      setStreamingMessage((current) => ({ text: `${current?.text ?? ""}${event.data.text}`, status: "streaming" }));
    } else if (event.type === "completed") {
      updateConversation(event.data.conversation);
      setStreamingMessage(null);
      setChatStatus("completed");
    } else if (event.type === "aborted") {
      updateConversation(event.data.conversation);
      setStreamingMessage(null);
      setChatStatus("aborted");
    } else if (event.type === "error") {
      setError(event.data.message);
      setStreamingMessage(null);
      setChatStatus("error");
    }
  }

  async function sendMessage(requestText = message): Promise<void> {
    if (isSending || !selectedApplication || !requestText.trim()) return;
    const submittedMessage = requestText;
    const hadConversation = conversation !== null;
    const token = requestSequenceRef.current + 1;
    requestSequenceRef.current = token;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setMessage("");
    setLastRequest(submittedMessage);
    setError(null);
    setChatStatus("submitted");
    setStreamingMessage({ text: "", status: "thinking" });

    try {
      const current = conversation ?? await createAiConversation({ applicationId: selectedApplication.id, productContext: context });
      if (!hadConversation) setConversation(current);
      const optimisticUser: AiMessageView = { id: crypto.randomUUID(), conversationId: current.id, role: "user", content: { text: submittedMessage }, runId: null, createdAtMs: Date.now() };
      setConversation((value) => value ? { ...value, messages: [...value.messages, optimisticUser] } : { ...current, messages: [optimisticUser] });
      if (!hadConversation) setConversations((items) => [current, ...items.filter((item) => item.id !== current.id)]);
      await streamAiConversationMessage(current.id, submittedMessage, { signal: abortController.signal, onEvent: (event) => handleStreamEvent(token, event) });
    } catch (reason) {
      if (abortController.signal.aborted) {
        if (token === requestSequenceRef.current) setChatStatus("aborted");
      } else if (token === requestSequenceRef.current) {
        setError(reason instanceof ApiRequestError ? reason.message : reason instanceof Error ? reason.message : "生成失败，请稍后重试");
        setStreamingMessage(null);
        setChatStatus("error");
        if (!hadConversation) setMessage(submittedMessage);
      }
    } finally {
      if (token === requestSequenceRef.current) {
        abortControllerRef.current = null;
        composerRef.current?.focus();
      }
    }
  }

  if (loading) return <section className="ai-page"><div className="empty-state"><Sparkles size={24} aria-hidden="true" />正在加载 AI 工作台…</div></section>;
  return <section className="ai-page">
    <div className="ai-page-heading"><div><p className="eyebrow">AI WORKBENCH</p><h2>AI 助手</h2><p>以商品上下文为基础，逐步接入可审计的运营应用。</p></div><button className="primary-button" type="button" onClick={startNewConversation}><MessageSquarePlus size={16} aria-hidden="true" />新建对话</button></div>
    {error && <div className="notice notice-error ai-error-notice" role="alert"><span>{error}</span>{lastRequest && !isSending && <button className="secondary-button" type="button" onClick={() => void sendMessage(lastRequest)}><RefreshCw size={14} aria-hidden="true" />重新发送</button>}</div>}
    <div className="ai-workspace">
      <aside className="ai-application-panel"><div className="ai-panel-heading"><strong>应用</strong><span>{applications.length}</span></div>{applications.map((application) => <button className={`ai-application-item${application.id === selectedApplication?.id ? " is-active" : ""}`} type="button" disabled={application.status !== "enabled"} onClick={() => { stopActiveRequest(); setSelectedApplicationId(application.id); setConversation(null); setContext(emptyContext); setMessage(""); setStreamingMessage(null); setChatStatus("idle"); }} key={application.id}><span><Sparkles size={15} aria-hidden="true" />{application.name}</span><small>{application.status === "enabled" ? "已上线" : "即将上线"}</small></button>)}<div className="ai-history-heading">历史对话</div>{conversations.map((item) => <button className={`ai-history-item${item.id === conversation?.id ? " is-active" : ""}`} type="button" onClick={() => void selectConversation(item.id)} key={item.id}>{item.title}</button>)}</aside>
      <main className="ai-chat-panel"><div className="ai-chat-heading"><div><strong>{selectedApplication?.name ?? "AI 助手"}</strong><span>{selectedApplication?.id === "product-image-prompt" ? "每次生成 3 套结构化候选" : "支持日常聊天和开放式问题"}</span></div><div className="ai-chat-statuses">{isSending && <span className="ai-run-status" role="status"><LoaderCircle className="ai-run-status-icon" size={13} aria-hidden="true" />{runStatusLabel(chatStatus)}</span>}<span className={relayAvailable ? "ai-relay-status is-ready" : "ai-relay-status"}>{relayAvailable === null ? "检查中" : relayAvailable ? "Relay 已连接" : "Relay 未连接"}</span></div></div><div className="ai-message-list" ref={messageListRef} role="log" aria-live="polite" aria-busy={isSending} onScroll={(event) => { const element = event.currentTarget; shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>{conversation?.messages.length ? conversation.messages.map((item) => <Message message={item} key={item.id} />) : <div className="ai-empty-chat"><Sparkles size={28} aria-hidden="true" /><strong>{selectedApplication?.id === "general-chat" ? "开始聊天" : "从商品资料开始"}</strong><p>{selectedApplication?.id === "general-chat" ? "可以直接输入任何日常问题，不需要填写商品资料。" : "商品资料可选；填写右侧上下文后，可以生成商品场景图提示词。"}</p></div>}{streamingMessage && <StreamingMessage message={streamingMessage} />}</div><div className="ai-composer"><textarea ref={composerRef} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={selectedApplication?.id === "general-chat" ? "输入任何内容开始聊天" : "例如：生成三套适合俄罗斯市场的生活场景图提示词"} rows={3} disabled={isSending} aria-label="输入消息" /><button className="primary-button" type="button" onClick={() => isSending ? stopActiveRequest() : void sendMessage()} disabled={!isSending && !message.trim()}>{isSending ? <><Square size={15} aria-hidden="true" />停止生成</> : <><Send size={16} aria-hidden="true" />发送</>}</button></div></main>
      <aside className="ai-context-panel"><div className="ai-panel-heading"><strong>商品上下文</strong><span>仅保存到本地历史</span></div><p className="ai-context-note">R0 只生成提示词，不生成图片、不上传图片、不修改商品。</p><label className="ai-field"><span>商品来源</span><select value={sourceId} onChange={(event) => selectSource(event.target.value)}><option value="">手动填写商品信息</option>{sources.filter((source) => source.kind === "draft").map((source) => <option value={source.id} key={source.id}>发布草稿 · {source.name}</option>)}{sources.filter((source) => source.kind === "product").map((source) => <option value={source.id} key={source.id}>现有商品 · {source.name}</option>)}</select></label><label className="ai-field"><span>商品名称</span><input value={context.name} onChange={(event) => updateContext("name", event.target.value)} placeholder="例如：厨房收纳盒" /></label><label className="ai-field"><span>商品类目</span><input value={context.category} onChange={(event) => updateContext("category", event.target.value)} placeholder="家居 / 收纳" /></label><div className="ai-field-row"><label className="ai-field"><span>材质</span><input value={context.material} onChange={(event) => updateContext("material", event.target.value)} /></label><label className="ai-field"><span>颜色</span><input value={context.color} onChange={(event) => updateContext("color", event.target.value)} /></label></div><label className="ai-field"><span>目标市场</span><input value={context.targetMarket} onChange={(event) => updateContext("targetMarket", event.target.value)} /></label><label className="ai-field"><span>图片用途</span><select value={context.imagePurpose} onChange={(event) => updateContext("imagePurpose", event.target.value)}><option>场景图</option><option>主图</option><option>细节图</option><option>白底图</option></select></label><label className="ai-field"><span>风格</span><input value={context.style} onChange={(event) => updateContext("style", event.target.value)} /></label><label className="ai-field"><span>比例</span><select value={context.aspectRatio} onChange={(event) => updateContext("aspectRatio", event.target.value)}><option>1:1</option><option>4:5</option><option>3:4</option><option>16:9</option></select></label></aside>
    </div>
  </section>;
}
