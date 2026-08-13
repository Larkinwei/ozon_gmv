import {
  Archive,
  ArrowDownUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ChartScatter,
  Clock3,
  Database,
  FileSpreadsheet,
  Filter,
  Lightbulb,
  ListChecks,
  PackageSearch,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import type {
  SelectionCandidate,
  SelectionCandidateCreateInput,
  SelectionCandidateStatus,
  SelectionCandidateUpdateInput,
  SelectionImportResult,
  SelectionKeywordSort,
  SelectionMarketProductDetail,
  SelectionMarketProductListItem,
  SelectionMarketProductSort,
} from "../../shared/contracts";
import {
  createSelectionCandidate,
  createWordstatJob,
  deleteSelectionImport,
  fetchSelectionCandidates,
  fetchSelectionImports,
  fetchSelectionKeyword,
  fetchSelectionKeywords,
  fetchSelectionMarketProduct,
  fetchSelectionMarketProducts,
  fetchSelectionOverview,
  fetchSelectionDiscoverySettings,
  fetchWordstatJobs,
  fetchWordstatSettings,
  testWordstatSettings,
  updateSelectionCandidate,
  updateWordstatSettings,
} from "../api";
import { AppNav } from "../components/AppNav";
import { SelectionCandidateDialog } from "../components/SelectionCandidateDialog";
import { SelectionCategoryPanel, SelectionCategorySourceCard } from "../components/SelectionCategoryPanel";
import {
  DiscoveryProductsPanel,
  DiscoveryQueriesPanel,
  DiscoverySourceSwitch,
} from "../components/SelectionDiscoveryPanels";
import { SelectionImportDialog } from "../components/SelectionImportDialog";
import { SelectionKeywordDrawer } from "../components/SelectionKeywordDrawer";
import { SelectionMarketProductDrawer } from "../components/SelectionMarketProductDrawer";
import { formatCompactNumber, formatMoney } from "../format";

type SelectionTab = "queries" | "products" | "categories" | "candidates" | "sources";

interface Notice {
  tone: "success" | "error";
  text: string;
}

const tabOptions: Array<{ value: SelectionTab; label: string; icon: typeof Lightbulb }> = [
  { value: "queries", label: "热搜词", icon: Lightbulb },
  { value: "products", label: "热销商品", icon: PackageSearch },
  { value: "categories", label: "类目分析", icon: ChartScatter },
  { value: "candidates", label: "候选池", icon: ListChecks },
  { value: "sources", label: "数据源", icon: Database },
];

const sortOptions: Array<{ value: SelectionKeywordSort; label: string }> = [
  { value: "demandScore", label: "需求分" },
  { value: "searchCount", label: "搜索次数" },
  { value: "cartRate", label: "加购转化率" },
  { value: "orderRate", label: "下单转化率" },
  { value: "averagePrice", label: "买家平均价格" },
];

const marketProductSortOptions: Array<{ value: SelectionMarketProductSort; label: string }> = [
  { value: "orderedAmount", label: "下单金额" },
  { value: "orderedUnits", label: "下单件数" },
  { value: "turnoverGrowth", label: "销售额增幅" },
  { value: "missedSales", label: "错失销售" },
  { value: "conversionRate", label: "下单转化率" },
  { value: "averagePrice", label: "平均价格" },
];

const candidateStatusOptions: Array<{ value: SelectionCandidateStatus; label: string }> = [
  { value: "watching", label: "观察" },
  { value: "recommended", label: "推荐推进" },
  { value: "rejected", label: "淘汰" },
];

function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(value);
}

/** Provides one decision workspace without exposing market data to the LAN wallboard. */
export default function SelectionPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [urlParams, setUrlParams] = useSearchParams();
  const initialTab = tabOptions.some((option) => option.value === urlParams.get("tab"))
    ? urlParams.get("tab") as SelectionTab
    : "queries";
  const [tab, setTab] = useState<SelectionTab>(initialTab);
  const [querySource, setQuerySource] = useState<"cloud" | "import">(urlParams.get("source") === "import" ? "import" : "cloud");
  const [productSource, setProductSource] = useState<"cloud" | "import">(urlParams.get("source") === "import" ? "import" : "cloud");
  const [discoveryPeriod, setDiscoveryPeriod] = useState<7 | 28>(urlParams.get("period") === "7" ? 7 : 28);
  const [categoryContext, setCategoryContext] = useState<{ id: string; name: string; level1Name: string } | null>(() => {
    const id = urlParams.get("categoryId");
    return id ? { id, name: urlParams.get("categoryName") ?? id, level1Name: urlParams.get("categoryLevel1") ?? "所属一级类目" } : null;
  });
  const [showImport, setShowImport] = useState(false);
  const [selectedKeywordId, setSelectedKeywordId] = useState<string | null>(null);
  const [selectedMarketProductId, setSelectedMarketProductId] = useState<string | null>(null);
  const [candidateDialog, setCandidateDialog] = useState<{ candidate?: SelectionCandidate; keywordId?: string; marketProductId?: string; marketProduct?: SelectionMarketProductListItem } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [sort, setSort] = useState<SelectionKeywordSort>("demandScore");
  const [page, setPage] = useState(1);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<Set<string>>(new Set());
  const [marketProductSearch, setMarketProductSearch] = useState("");
  const [marketCategoryLevel1, setMarketCategoryLevel1] = useState("");
  const [marketCategoryLevel3, setMarketCategoryLevel3] = useState("");
  const [marketProductFlag, setMarketProductFlag] = useState("");
  const [marketMinimumPrice, setMarketMinimumPrice] = useState("");
  const [marketMaximumPrice, setMarketMaximumPrice] = useState("");
  const [marketProductSort, setMarketProductSort] = useState<SelectionMarketProductSort>("orderedAmount");
  const [marketProductPage, setMarketProductPage] = useState(1);
  const [candidateStatus, setCandidateStatus] = useState<SelectionCandidateStatus | "all">("all");
  const [candidateSearch, setCandidateSearch] = useState("");
  const finishedJobsSignature = useRef("");

  const overviewQuery = useQuery({ queryKey: ["selection-overview"], queryFn: fetchSelectionOverview });
  const keywordsQuery = useQuery({
    queryKey: ["selection-keywords", page, search, minimumPrice, maximumPrice, sort],
    queryFn: () => fetchSelectionKeywords({
      page,
      pageSize: 20,
      sort,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(minimumPrice ? { minimumPrice: Number(minimumPrice) } : {}),
      ...(maximumPrice ? { maximumPrice: Number(maximumPrice) } : {}),
    }),
  });
  const detailQuery = useQuery({
    queryKey: ["selection-keyword", selectedKeywordId],
    queryFn: () => fetchSelectionKeyword(selectedKeywordId!),
    enabled: Boolean(selectedKeywordId),
  });
  const marketProductsQuery = useQuery({
    queryKey: ["selection-market-products", marketProductPage, marketProductSearch, marketCategoryLevel1, marketCategoryLevel3, marketProductFlag, marketMinimumPrice, marketMaximumPrice, marketProductSort],
    queryFn: () => fetchSelectionMarketProducts({
      page: marketProductPage,
      pageSize: 20,
      sort: marketProductSort,
      ...(marketProductSearch.trim() ? { search: marketProductSearch.trim() } : {}),
      ...(marketCategoryLevel1 ? { categoryLevel1: marketCategoryLevel1 } : {}),
      ...(marketCategoryLevel3 ? { categoryLevel3: marketCategoryLevel3 } : {}),
      ...(marketProductFlag ? { productFlag: marketProductFlag } : {}),
      ...(marketMinimumPrice ? { minimumPrice: Number(marketMinimumPrice) } : {}),
      ...(marketMaximumPrice ? { maximumPrice: Number(marketMaximumPrice) } : {}),
    }),
    enabled: tab === "products" && productSource === "import",
  });
  const marketProductDetailQuery = useQuery({
    queryKey: ["selection-market-product", selectedMarketProductId],
    queryFn: () => fetchSelectionMarketProduct(selectedMarketProductId!),
    enabled: Boolean(selectedMarketProductId),
  });
  const candidatesQuery = useQuery({
    queryKey: ["selection-candidates", candidateStatus, candidateSearch],
    queryFn: () => fetchSelectionCandidates({
      ...(candidateStatus !== "all" ? { status: candidateStatus } : {}),
      ...(candidateSearch.trim() ? { search: candidateSearch.trim() } : {}),
    }),
    enabled: tab === "candidates",
  });
  const importsQuery = useQuery({ queryKey: ["selection-imports"], queryFn: fetchSelectionImports, enabled: tab === "sources" });
  const settingsQuery = useQuery({ queryKey: ["wordstat-settings"], queryFn: fetchWordstatSettings, enabled: tab === "sources" });
  const categorySettingsQuery = useQuery({ queryKey: ["selection-discovery-settings"], queryFn: fetchSelectionDiscoverySettings, enabled: tab === "sources" });
  const jobsQuery = useQuery({
    queryKey: ["wordstat-jobs"],
    queryFn: fetchWordstatJobs,
    enabled: tab === "sources" || selectedKeywordIds.size > 0 || Boolean(selectedKeywordId),
    refetchInterval: (query) => query.state.data?.some((job) => job.status === "queued" || job.status === "running") ? 1_000 : false,
  });

  useEffect(() => {
    const signature = (jobsQuery.data ?? []).filter((job) => job.finishedAt).map((job) => `${job.id}:${job.finishedAt}`).join("|");
    if (signature && signature !== finishedJobsSignature.current) {
      finishedJobsSignature.current = signature;
      void queryClient.invalidateQueries({ queryKey: ["selection-keywords"] });
      void queryClient.invalidateQueries({ queryKey: ["selection-keyword"] });
      void queryClient.invalidateQueries({ queryKey: ["selection-overview"] });
    }
  }, [jobsQuery.data, queryClient]);

  const wordstatMutation = useMutation({
    mutationFn: ({ ids, force }: { ids: string[]; force: boolean }) => createWordstatJob(ids, force),
    onSuccess: async (job) => {
      setSelectedKeywordIds(new Set());
      setNotice({ tone: "success", text: `Wordstat 补强任务已提交，共 ${job.total} 个关键词。` });
      await queryClient.invalidateQueries({ queryKey: ["wordstat-jobs"] });
    },
    onError: (error) => setNotice({ tone: "error", text: error.message }),
  });
  const createCandidateMutation = useMutation({
    mutationFn: (input: SelectionCandidateCreateInput) => createSelectionCandidate(input),
    onSuccess: async () => {
      setCandidateDialog(null);
      setNotice({ tone: "success", text: "已加入候选池，初始状态为“观察”。" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["selection-candidates"] }),
        queryClient.invalidateQueries({ queryKey: ["selection-overview"] }),
      ]);
    },
  });
  const updateCandidateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SelectionCandidateUpdateInput }) => updateSelectionCandidate(id, input),
    onSuccess: async () => {
      setCandidateDialog(null);
      setNotice({ tone: "success", text: "候选商品判断已保存。" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["selection-candidates"] }),
        queryClient.invalidateQueries({ queryKey: ["selection-overview"] }),
      ]);
    },
  });

  function toggleKeyword(id: string): void {
    setSelectedKeywordIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  }

  /** Keeps the active analysis route copyable without storing transient filters. */
  function selectTab(nextTab: SelectionTab): void {
    setTab(nextTab);
    const next = new URLSearchParams(urlParams);
    next.set("tab", nextTab);
    next.set("source", nextTab === "products" ? productSource : nextTab === "queries" ? querySource : "cloud");
    setUrlParams(next, { replace: true });
  }

  function openCategory(
    category: { id: string; name: string; level1Name: string },
    period: 7 | 28,
  ): void {
    setCategoryContext(category);
    setDiscoveryPeriod(period);
    setProductSource("cloud");
    setTab("products");
    setUrlParams({
      tab: "products", source: "cloud", categoryId: category.id,
      categoryName: category.name, categoryLevel1: category.level1Name, period: String(period), detail: "products",
    });
  }

  function setCategoryMode(mode: "products" | "queries"): void {
    const nextTab = mode === "products" ? "products" : "queries";
    setTab(nextTab);
    if (mode === "products") setProductSource("cloud");
    else setQuerySource("cloud");
    const next = new URLSearchParams(urlParams);
    next.set("tab", nextTab); next.set("source", "cloud"); next.set("detail", mode);
    setUrlParams(next, { replace: true });
  }

  function clearCategoryContext(): void {
    setCategoryContext(null);
    const next = new URLSearchParams(urlParams);
    ["categoryId", "categoryName", "categoryLevel1", "detail"].forEach((key) => next.delete(key));
    setUrlParams(next, { replace: true });
  }

  /** Clears product filters without changing the user's selected sort order. */
  function clearMarketProductFilters(): void {
    setMarketProductSearch("");
    setMarketCategoryLevel1("");
    setMarketCategoryLevel3("");
    setMarketProductFlag("");
    setMarketMinimumPrice("");
    setMarketMaximumPrice("");
    setMarketProductPage(1);
  }

  async function importCompleted(result: SelectionImportResult): Promise<void> {
    if (result.kind === "market_product") {
      setProductSource("import");
      setTab("products");
    } else {
      setQuerySource("import");
      setTab("queries");
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["selection-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-keywords"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-imports"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-market-products"] }),
    ]);
  }

  const totalPages = Math.max(1, Math.ceil((keywordsQuery.data?.total ?? 0) / 20));
  const marketProductTotalPages = Math.max(1, Math.ceil((marketProductsQuery.data?.total ?? 0) / 20));
  const dialogKeywordQuery = useQuery({
    queryKey: ["selection-keyword", candidateDialog?.keywordId],
    queryFn: () => fetchSelectionKeyword(candidateDialog!.keywordId!),
    enabled: Boolean(candidateDialog?.keywordId),
  });
  const dialogMarketProductQuery = useQuery({
    queryKey: ["selection-market-product", candidateDialog?.marketProductId],
    queryFn: () => fetchSelectionMarketProduct(candidateDialog!.marketProductId!),
    enabled: Boolean(candidateDialog?.marketProductId) && !candidateDialog?.marketProduct,
  });
  const activeCandidate = candidateDialog?.candidate ?? null;
  const dialogError = createCandidateMutation.error?.message ?? updateCandidateMutation.error?.message ?? null;

  return (
    <div className="admin-page selection-page">
      <a className="skip-link" href="#selection-main">跳到主要内容</a>
      <header className="admin-header">
        <Link className="brand-lockup" to="/dashboard"><div className="brand-mark" aria-hidden="true">O</div><div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div></Link>
        <AppNav />
      </header>
      <main className="admin-main selection-main" id="selection-main">
        <div className="page-title-row">
          <div><p className="eyebrow">PRODUCT DISCOVERY</p><h2>选品分析</h2><p>结合 Ozon 关键词、热销商品与类目快照，形成可追踪的候选决策。</p></div>
          <button className="primary-button" type="button" onClick={() => setShowImport(true)}><FileSpreadsheet size={18} />导入 Ozon 报表</button>
        </div>
        {notice && <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" && <Check size={17} />}{notice.text}</div>}
        <OverviewCards overview={overviewQuery.data} loading={overviewQuery.isLoading} />
        <div className="selection-workspace">
          <div className="selection-tabs" role="tablist" aria-label="选品分析模块">
            {tabOptions.map((option) => <button className={tab === option.value ? "is-active" : ""} type="button" role="tab" aria-selected={tab === option.value} onClick={() => selectTab(option.value)} key={option.value}><option.icon size={17} />{option.label}</button>)}
          </div>
          {tab === "queries" && (<>
            <div className="discovery-source-row"><DiscoverySourceSwitch value={querySource} cloudLabel="云端热词" importLabel="导入机会词" onChange={(value) => { setQuerySource(value); const next = new URLSearchParams(urlParams); next.set("source", value); setUrlParams(next, { replace: true }); }} /></div>
            {querySource === "cloud" ? <DiscoveryQueriesPanel category={categoryContext} selectedIds={selectedKeywordIds} onToggle={toggleKeyword} onWordstat={() => wordstatMutation.mutate({ ids: [...selectedKeywordIds], force: false })} wordstatPending={wordstatMutation.isPending} onCategoryMode={setCategoryMode} onClearCategory={clearCategoryContext} /> : <section className="selection-tab-panel" role="tabpanel" aria-label="导入机会词">
              <div className="selection-toolbar">
                <label className="selection-search"><Search size={17} /><span className="sr-only">搜索关键词</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索俄文关键词" /></label>
                <div className="selection-filter-group"><Filter size={16} aria-hidden="true" /><label><span>价格从</span><input inputMode="decimal" value={minimumPrice} onChange={(event) => { setMinimumPrice(event.target.value); setPage(1); }} placeholder="₽ 0" /></label><label><span>到</span><input inputMode="decimal" value={maximumPrice} onChange={(event) => { setMaximumPrice(event.target.value); setPage(1); }} placeholder="₽ 5000" /></label></div>
                <label className="selection-sort"><ArrowDownUp size={16} /><span className="sr-only">排序字段</span><select value={sort} onChange={(event) => { setSort(event.target.value as SelectionKeywordSort); setPage(1); }}>{sortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}优先</option>)}</select></label>
                <button className="secondary-button compact-button" type="button" disabled={selectedKeywordIds.size === 0 || wordstatMutation.isPending} onClick={() => wordstatMutation.mutate({ ids: [...selectedKeywordIds], force: false })}><Sparkles size={16} />Wordstat 补强 {selectedKeywordIds.size > 0 && `(${selectedKeywordIds.size})`}</button>
              </div>
              <div className="selection-score-note"><Lightbulb size={17} /><p><strong>需求分 = 45% 搜索次数 + 20% 加购转化 + 35% 下单转化</strong><span>仅为同一导入批次分位数；不是销量、利润或完整选品结论。平均价格只用于筛选。</span></p></div>
              <KeywordTable
                loading={keywordsQuery.isLoading}
                error={keywordsQuery.error?.message ?? null}
                items={keywordsQuery.data?.items ?? []}
                selectedIds={selectedKeywordIds}
                onToggle={toggleKeyword}
                onOpen={setSelectedKeywordId}
                onImport={() => setShowImport(true)}
              />
              {(keywordsQuery.data?.total ?? 0) > 0 && <div className="selection-pagination"><span>共 {(keywordsQuery.data?.total ?? 0).toLocaleString("zh-CN")} 个关键词</span><div><button className="icon-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div>}
            </section>}
          </>)}
          {tab === "products" && (<>
            <div className="discovery-source-row"><DiscoverySourceSwitch value={productSource} cloudLabel="云端榜单" importLabel="导入报表" onChange={(value) => { setProductSource(value); const next = new URLSearchParams(urlParams); next.set("source", value); setUrlParams(next, { replace: true }); }} /></div>
            {productSource === "cloud" ? <DiscoveryProductsPanel category={categoryContext} periodDays={discoveryPeriod} onPeriod={(period) => { setDiscoveryPeriod(period); const next = new URLSearchParams(urlParams); next.set("period", String(period)); setUrlParams(next, { replace: true }); }} onCategoryMode={setCategoryMode} onClearCategory={clearCategoryContext} onCandidate={(item) => setCandidateDialog({ marketProductId: item.id, marketProduct: item })} /> : <MarketProductsPanel
              page={marketProductPage}
              totalPages={marketProductTotalPages}
              marketProductCount={overviewQuery.data?.marketProductCount ?? 0}
              data={marketProductsQuery.data}
              loading={marketProductsQuery.isLoading}
              error={marketProductsQuery.error?.message ?? null}
              search={marketProductSearch}
              categoryLevel1={marketCategoryLevel1}
              categoryLevel3={marketCategoryLevel3}
              productFlag={marketProductFlag}
              minimumPrice={marketMinimumPrice}
              maximumPrice={marketMaximumPrice}
              sort={marketProductSort}
              onSearch={(value) => { setMarketProductSearch(value); setMarketProductPage(1); }}
              onCategoryLevel1={(value) => { setMarketCategoryLevel1(value); setMarketProductPage(1); }}
              onCategoryLevel3={(value) => { setMarketCategoryLevel3(value); setMarketProductPage(1); }}
              onProductFlag={(value) => { setMarketProductFlag(value); setMarketProductPage(1); }}
              onMinimumPrice={(value) => { setMarketMinimumPrice(value); setMarketProductPage(1); }}
              onMaximumPrice={(value) => { setMarketMaximumPrice(value); setMarketProductPage(1); }}
              onSort={(value) => { setMarketProductSort(value); setMarketProductPage(1); }}
              onPage={setMarketProductPage}
              onOpen={setSelectedMarketProductId}
              onImport={() => setShowImport(true)}
              onClearFilters={clearMarketProductFilters}
            />}
          </>)}
          {tab === "candidates" && (
            <CandidatesPanel
              candidates={candidatesQuery.data ?? []}
              loading={candidatesQuery.isLoading}
              error={candidatesQuery.error?.message ?? null}
              status={candidateStatus}
              search={candidateSearch}
              onStatus={setCandidateStatus}
              onSearch={setCandidateSearch}
              onCreate={() => setCandidateDialog({})}
              onEdit={(candidate) => setCandidateDialog({ candidate })}
              onOpenKeyword={setSelectedKeywordId}
              onOpenMarketProduct={setSelectedMarketProductId}
            />
          )}
          {tab === "categories" && <SelectionCategoryPanel onNotice={setNotice} onOpenCategory={openCategory} />}
          {tab === "sources" && (
            <SourcesPanel
              imports={importsQuery.data ?? []}
              importsLoading={importsQuery.isLoading}
              settings={settingsQuery.data}
              categorySettings={categorySettingsQuery.data}
              jobs={jobsQuery.data ?? []}
              onImport={() => setShowImport(true)}
              onDeleteImport={async (id) => {
                if (!window.confirm("删除这次错误导入及其数据快照？候选判断会保留，此操作不可恢复。")) return;
                try {
                  await deleteSelectionImport(id);
                  setNotice({ tone: "success", text: "错误导入已删除。" });
                  await Promise.all([queryClient.invalidateQueries({ queryKey: ["selection-imports"] }), queryClient.invalidateQueries({ queryKey: ["selection-keywords"] }), queryClient.invalidateQueries({ queryKey: ["selection-overview"] })]);
                } catch (error) {
                  setNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败" });
                }
              }}
              onSettingsSaved={async () => {
                setNotice({ tone: "success", text: "Wordstat 凭证已加密保存。" });
                await queryClient.invalidateQueries({ queryKey: ["wordstat-settings"] });
              }}
              onCategorySettingsSaved={async () => {
                await queryClient.invalidateQueries({ queryKey: ["selection-discovery-settings"] });
              }}
              onNotice={setNotice}
            />
          )}
        </div>
      </main>
      {showImport && <SelectionImportDialog onClose={() => setShowImport(false)} onImported={(result) => void importCompleted(result)} />}
      {selectedKeywordId && <SelectionKeywordDrawer keyword={detailQuery.data ?? null} loading={detailQuery.isLoading} refreshing={wordstatMutation.isPending} onClose={() => setSelectedKeywordId(null)} onAddCandidate={(keyword) => setCandidateDialog({ keywordId: keyword.id })} onRefreshWordstat={(keywordId) => wordstatMutation.mutate({ ids: [keywordId], force: true })} />}
      {selectedMarketProductId && <SelectionMarketProductDrawer product={marketProductDetailQuery.data ?? null} loading={marketProductDetailQuery.isLoading} onClose={() => setSelectedMarketProductId(null)} onAddCandidate={(product) => setCandidateDialog({ marketProductId: product.id })} />}
      {candidateDialog && (
        <SelectionCandidateDialog
          key={activeCandidate?.id ?? candidateDialog.keywordId ?? candidateDialog.marketProductId ?? "new"}
          candidate={activeCandidate}
          keyword={dialogKeywordQuery.data ?? null}
          marketProduct={candidateDialog.marketProduct ?? dialogMarketProductQuery.data ?? null}
          pending={createCandidateMutation.isPending || updateCandidateMutation.isPending}
          error={dialogError}
          onClose={() => setCandidateDialog(null)}
          onCreate={(input) => createCandidateMutation.mutate(input)}
          onUpdate={(id, input) => updateCandidateMutation.mutate({ id, input })}
        />
      )}
    </div>
  );
}

function OverviewCards(props: { overview: Awaited<ReturnType<typeof fetchSelectionOverview>> | undefined; loading: boolean }): React.JSX.Element {
  const candidateTotal = props.overview ? Object.values(props.overview.candidateCounts).reduce((sum, value) => sum + value, 0) : 0;
  const cards = [
    { label: "机会关键词", value: props.overview?.keywordCount ?? 0, note: `${props.overview?.scoredKeywordCount ?? 0} 个已生成需求分`, icon: Search, tone: "" },
    { label: "热销商品", value: props.overview?.marketProductCount ?? 0, note: props.overview?.latestMarketProductSnapshotDate ? `${props.overview.latestMarketProductSnapshotDate} 最新榜单` : "等待导入商品报表", icon: PackageSearch, tone: "kpi-card--cyan" },
    { label: "Wordstat 已补强", value: props.overview?.wordstatReadyCount ?? 0, note: "含俄罗斯趋势", icon: Sparkles, tone: "kpi-card--violet" },
    { label: "候选商品", value: candidateTotal, note: `${props.overview?.candidateCounts.recommended ?? 0} 个推荐推进`, icon: Archive, tone: "kpi-card--red" },
  ];
  return <section className="selection-kpi-grid" aria-label="选品数据概览">{cards.map((card) => <article className={`kpi-card selection-kpi ${card.tone}`} key={card.label}><div className="kpi-card__header"><span>{card.label}</span><span className="kpi-icon"><card.icon size={17} /></span></div><strong className="kpi-value">{props.loading ? "—" : card.value.toLocaleString("zh-CN")}</strong><p>{card.note}</p></article>)}</section>;
}

interface KeywordTableProps {
  loading: boolean;
  error: string | null;
  items: Awaited<ReturnType<typeof fetchSelectionKeywords>>["items"];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onImport: () => void;
}

function KeywordTable(props: KeywordTableProps): React.JSX.Element {
  if (props.loading) return <div className="selection-table-loading" aria-busy="true">正在分析关键词机会…</div>;
  if (props.error) return <div className="page-error"><h3>机会词库加载失败</h3><p>{props.error}</p></div>;
  if (props.items.length === 0) return <div className="selection-empty"><FileSpreadsheet size={31} /><h3>还没有可分析的关键词</h3><p>导入 Ozon “热门商品/热门搜索”报表，系统会标准化指标并计算批次需求分。</p><button className="primary-button" type="button" onClick={props.onImport}>导入第一份报表</button></div>;
  return (
    <div className="selection-table-card"><div className="table-scroll"><table className="selection-keyword-table"><thead><tr><th scope="col"><span className="sr-only">选择</span></th><th scope="col">关键词</th><th scope="col">需求分</th><th scope="col">搜索次数</th><th scope="col">加购率</th><th scope="col">下单率</th><th scope="col">平均价格</th><th scope="col">Wordstat</th></tr></thead><tbody>{props.items.map((item) => <tr key={item.id} onClick={() => props.onOpen(item.id)}><td onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={props.selectedIds.has(item.id)} onChange={() => props.onToggle(item.id)} aria-label={`选择 ${item.phrase}`} /></td><td><button className="keyword-link" type="button" onClick={() => props.onOpen(item.id)}><strong>{item.phrase}</strong><small>{item.snapshotDate}</small></button></td><td><span className={item.demandScore === null ? "demand-score demand-score--empty" : "demand-score"}>{item.demandScore ?? "样本不足"}</span></td><td data-label="搜索次数">{formatCompactNumber(item.searchCount)}</td><td data-label="加购率">{formatPercent(item.cartRate)}</td><td data-label="下单率">{formatPercent(item.orderRate)}</td><td data-label="平均价格">{item.averagePrice ? formatMoney(item.averagePrice) : "—"}</td><td data-label="Wordstat"><span className={`wordstat-status wordstat-status--${item.wordstatStatus}`}>{wordstatStatusLabel(item.wordstatStatus)}</span></td></tr>)}</tbody></table></div></div>
  );
}

interface MarketProductsPanelProps {
  page: number;
  totalPages: number;
  marketProductCount: number;
  data: Awaited<ReturnType<typeof fetchSelectionMarketProducts>> | undefined;
  loading: boolean;
  error: string | null;
  search: string;
  categoryLevel1: string;
  categoryLevel3: string;
  productFlag: string;
  minimumPrice: string;
  maximumPrice: string;
  sort: SelectionMarketProductSort;
  onSearch: (value: string) => void;
  onCategoryLevel1: (value: string) => void;
  onCategoryLevel3: (value: string) => void;
  onProductFlag: (value: string) => void;
  onMinimumPrice: (value: string) => void;
  onMaximumPrice: (value: string) => void;
  onSort: (value: SelectionMarketProductSort) => void;
  onPage: (page: number) => void;
  onOpen: (id: string) => void;
  onImport: () => void;
  onClearFilters: () => void;
}

export function MarketProductsPanel(props: MarketProductsPanelProps): React.JSX.Element {
  const items = props.data?.items ?? [];
  let content: React.ReactNode;
  if (props.loading) {
    content = <div className="selection-table-loading" aria-busy="true">正在读取热销商品…</div>;
  } else if (props.error) {
    content = <div className="page-error"><h3>热销商品加载失败</h3><p>{props.error}</p></div>;
  } else if (items.length === 0 && props.marketProductCount > 0) {
    content = <div className="selection-empty"><PackageSearch size={31} /><h3>没有匹配的热销商品</h3><p>当前搜索或筛选条件没有结果，请调整条件后重试。</p><button className="secondary-button compact-button" type="button" onClick={props.onClearFilters}>清除筛选</button></div>;
  } else if (items.length === 0) {
    content = <div className="selection-empty"><PackageSearch size={31} /><h3>还没有热销商品数据</h3><p>导入 Ozon“分析 → Ozon 上的商品”页面下载的所有指标 XLSX 报表。</p><button className="primary-button" type="button" onClick={props.onImport}>导入商品报表</button></div>;
  } else {
    content = (
      <>
        <div className="selection-table-card"><div className="table-scroll"><table className="selection-keyword-table market-product-table"><thead><tr><th scope="col">商品</th><th scope="col">类目</th><th scope="col">下单件数</th><th scope="col">下单金额</th><th scope="col">销售额变化</th><th scope="col">平均价格</th><th scope="col">下单转化率</th><th scope="col">供给信号</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td data-label="商品"><button className="market-product-link" type="button" onClick={() => props.onOpen(item.id)}><strong>{item.name}</strong><small>{item.brand} · {item.seller}</small></button></td><td data-label="类目"><strong>{item.categoryLevel3}</strong><small>{item.categoryLevel1}</small></td><td data-label="下单件数">{item.orderedUnits.toLocaleString("zh-CN")}</td><td data-label="下单金额">{formatMoney(item.orderedAmount)}</td><td data-label="销售额变化"><span className={`market-growth ${item.turnoverGrowth !== null && item.turnoverGrowth < 0 ? "is-negative" : ""}`}>{item.turnoverGrowth === null ? "无数据" : new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }).format(item.turnoverGrowth)}</span></td><td data-label="平均价格">{formatMoney(item.averagePrice)}</td><td data-label="下单转化率">{formatPercent(item.impressionToOrderRate)}</td><td data-label="供给信号"><strong>{item.missedSales.toLocaleString("zh-CN")} 错失</strong><small>{item.outOfStockDays === null ? "缺货无数据" : `缺货 ${item.outOfStockDays} 天`}</small></td></tr>)}</tbody></table></div></div>
        <div className="selection-pagination"><span>共 {(props.data?.total ?? 0).toLocaleString("zh-CN")} 个商品</span><div><button className="icon-button" type="button" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{props.page} / {props.totalPages}</strong><button className="icon-button" type="button" disabled={props.page >= props.totalPages} onClick={() => props.onPage(props.page + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div>
      </>
    );
  }
  return (
    <section className="selection-tab-panel" role="tabpanel" aria-label="热销商品">
      <div className="market-product-toolbar">
        <label className="selection-search"><Search size={17} /><span className="sr-only">搜索商品、品牌、卖家、类目或标签</span><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索商品、品牌、卖家、类目或标签" /></label>
        <label className="selection-sort"><span>一级类目</span><select value={props.categoryLevel1} onChange={(event) => props.onCategoryLevel1(event.target.value)}><option value="">全部一级类目</option>{props.data?.facets.categoryLevel1.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
        <label className="selection-sort"><span>三级类目</span><select value={props.categoryLevel3} onChange={(event) => props.onCategoryLevel3(event.target.value)}><option value="">全部三级类目</option>{props.data?.facets.categoryLevel3.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
        <label className="selection-sort"><span>商品标签</span><select value={props.productFlag} onChange={(event) => props.onProductFlag(event.target.value)}><option value="">全部标签</option>{props.data?.facets.productFlags.map((flag) => <option value={flag} key={flag}>{flag}</option>)}</select></label>
        <div className="selection-filter-group"><Filter size={16} aria-hidden="true" /><label><span>价格从</span><input inputMode="decimal" value={props.minimumPrice} onChange={(event) => props.onMinimumPrice(event.target.value)} placeholder="₽ 0" /></label><label><span>到</span><input inputMode="decimal" value={props.maximumPrice} onChange={(event) => props.onMaximumPrice(event.target.value)} placeholder="₽ 5000" /></label></div>
        <label className="selection-sort"><ArrowDownUp size={16} /><span className="sr-only">热销商品排序</span><select value={props.sort} onChange={(event) => props.onSort(event.target.value as SelectionMarketProductSort)}>{marketProductSortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}优先</option>)}</select></label>
      </div>
      <div className="selection-score-note market-product-boundary"><PackageSearch size={17} /><p><strong>官方近 28 天商品指标，不生成综合机会分</strong><span>结果只代表当次后台筛选和导出范围，不等于 Ozon 全站完整商品总量；请结合成本与利润继续判断。</span></p></div>
      {content}
    </section>
  );
}

function wordstatStatusLabel(status: "missing" | "ready" | "failed" | "queued"): string {
  return { missing: "未补强", ready: "已完成", failed: "失败", queued: "处理中" }[status];
}

interface CandidatesPanelProps {
  candidates: SelectionCandidate[];
  loading: boolean;
  error: string | null;
  status: SelectionCandidateStatus | "all";
  search: string;
  onStatus: (status: SelectionCandidateStatus | "all") => void;
  onSearch: (value: string) => void;
  onCreate: () => void;
  onEdit: (candidate: SelectionCandidate) => void;
  onOpenKeyword: (id: string) => void;
  onOpenMarketProduct: (id: string) => void;
}

function CandidatesPanel(props: CandidatesPanelProps): React.JSX.Element {
  return <section className="selection-tab-panel" role="tabpanel" aria-label="候选池"><div className="selection-toolbar"><label className="selection-search"><Search size={17} /><span className="sr-only">搜索候选商品</span><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索商品、类目或备注" /></label><label className="selection-sort"><Filter size={16} /><span className="sr-only">候选状态</span><select value={props.status} onChange={(event) => props.onStatus(event.target.value as SelectionCandidateStatus | "all")}><option value="all">全部状态</option>{candidateStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="primary-button compact-button" type="button" onClick={props.onCreate}><Plus size={16} />手工添加</button></div>{props.loading ? <div className="selection-table-loading" aria-busy="true">正在读取候选池…</div> : props.error ? <div className="page-error"><h3>候选池加载失败</h3><p>{props.error}</p></div> : props.candidates.length === 0 ? <div className="selection-empty"><ListChecks size={31} /><h3>候选池还是空的</h3><p>可以从机会词或热销商品详情一键加入，也可以手工记录已关注的商品。</p><button className="primary-button" type="button" onClick={props.onCreate}>添加候选商品</button></div> : <div className="candidate-grid">{props.candidates.map((candidate) => <article className="candidate-card" key={candidate.id}><div className="candidate-card__heading"><span className={`candidate-status candidate-status--${candidate.status}`}>{candidateStatusOptions.find((option) => option.value === candidate.status)?.label}</span><small>{new Date(candidate.updatedAt).toLocaleDateString("zh-CN")} 更新</small></div><h3>{candidate.name}</h3><p className="candidate-category">{candidate.category ?? "未填写类目"}</p><dl><div><dt>目标售价</dt><dd>{candidate.targetPrice ? formatMoney(candidate.targetPrice) : "待评估"}</dd></div><div><dt>关联关键词</dt><dd>{candidate.keyword ? <button type="button" onClick={() => props.onOpenKeyword(candidate.keyword!.id)}>{candidate.keyword.phrase}</button> : "未关联"}</dd></div>{candidate.marketProduct && <div><dt>最新商品数据</dt><dd><button type="button" onClick={() => props.onOpenMarketProduct(candidate.marketProduct!.id)}>{candidate.marketProduct.orderedUnits.toLocaleString("zh-CN")} 件 · {candidate.marketProduct.snapshotDate}</button></dd></div>}</dl>{candidate.decisionReason && <p className="candidate-reason">{candidate.decisionReason}</p>}<div className="candidate-card__actions">{candidate.ozonUrl && <a className="secondary-button compact-button" href={candidate.ozonUrl} target="_blank" rel="noreferrer">打开 Ozon</a>}<button className="primary-button compact-button" type="button" onClick={() => props.onEdit(candidate)}>记录判断</button></div></article>)}</div>}</section>;
}

interface SourcesPanelProps {
  imports: Awaited<ReturnType<typeof fetchSelectionImports>>;
  importsLoading: boolean;
  settings: Awaited<ReturnType<typeof fetchWordstatSettings>> | undefined;
  categorySettings: Awaited<ReturnType<typeof fetchSelectionDiscoverySettings>> | undefined;
  jobs: Awaited<ReturnType<typeof fetchWordstatJobs>>;
  onImport: () => void;
  onDeleteImport: (id: string) => Promise<void>;
  onSettingsSaved: () => Promise<void>;
  onCategorySettingsSaved: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}

function SourcesPanel(props: SourcesPanelProps): React.JSX.Element {
  const [folderId, setFolderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  useEffect(() => { if (props.settings?.folderId) setFolderId(props.settings.folderId); }, [props.settings?.folderId]);
  const saveMutation = useMutation({ mutationFn: () => updateWordstatSettings(folderId.trim(), apiKey.trim() || undefined), onSuccess: async () => { setApiKey(""); await props.onSettingsSaved(); }, onError: (error) => props.onNotice({ tone: "error", text: error.message }) });
  const testMutation = useMutation({ mutationFn: testWordstatSettings, onSuccess: () => props.onNotice({ tone: "success", text: "Wordstat 正式接口连接正常。" }), onError: (error) => props.onNotice({ tone: "error", text: error.message }) });
  return <section className="selection-tab-panel sources-panel" role="tabpanel" aria-label="数据源"><div className="source-grid"><article className="source-card"><div className="source-card__heading"><div className="source-icon"><FileSpreadsheet size={20} /></div><div><p className="eyebrow">OZON REPORTS</p><h3>Ozon 报表导入</h3><p>支持关键词和全市场商品报表，不长期保存原文件。</p></div><button className="primary-button compact-button" type="button" onClick={props.onImport}><Plus size={15} />导入</button></div>{props.importsLoading ? <div className="selection-table-loading" aria-busy="true">读取导入记录…</div> : props.imports.length === 0 ? <div className="source-empty">还没有导入记录</div> : <div className="import-history">{props.imports.map((item) => <div key={item.id}><FileSpreadsheet size={17} /><p><strong>{item.fileName}</strong><span><em className={`import-kind-badge import-kind-badge--${item.kind}`}>{item.kind === "market_product" ? "热销商品" : "关键词"}</em>{item.snapshotDate} · {item.reportPeriodDays ? `近 ${item.reportPeriodDays} 天 · ` : ""}{item.validRows.toLocaleString("zh-CN")} 条有效</span></p><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time><button className="icon-button" type="button" onClick={() => void props.onDeleteImport(item.id)} aria-label={`删除 ${item.fileName}`}><Trash2 size={17} /></button></div>)}</div>}</article><article className="source-card"><div className="source-card__heading"><div className="source-icon source-icon--cyan"><Sparkles size={20} /></div><div><p className="eyebrow">YANDEX CLOUD SEARCH API</p><h3>Wordstat 补强</h3><p>俄罗斯地区 225、全部设备；只处理手工提交的关键词。</p></div><span className={`source-state ${props.settings?.configured ? "is-ready" : ""}`}>{props.settings?.configured ? "已配置" : "待配置"}</span></div><form className="wordstat-settings-form" onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}><label className="field"><span>Folder ID *</span><input value={folderId} onChange={(event) => setFolderId(event.target.value)} required /></label><label className="field"><span>服务账号 API Key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!props.settings?.hasApiKey} placeholder={props.settings?.hasApiKey ? "已加密保存；留空保持现有密钥" : "输入 API Key"} /><small>使用 AES-256-GCM 加密保存，接口永不返回明文。</small></label><div className="settings-actions"><button className="primary-button" type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? "正在保存…" : "保存凭证"}</button><button className="secondary-button" type="button" onClick={() => testMutation.mutate()} disabled={!props.settings?.configured || testMutation.isPending}>{testMutation.isPending ? "正在测试…" : "测试连接"}</button></div></form></article><SelectionCategorySourceCard settings={props.categorySettings} onSaved={props.onCategorySettingsSaved} onNotice={props.onNotice} /></div><article className="source-card source-card--jobs"><div className="source-card__heading"><div className="source-icon source-icon--violet"><Clock3 size={20} /></div><div><p className="eyebrow">ENRICHMENT JOBS</p><h3>补强任务</h3><p>并发数 3；24 小时内已有结果默认复用，失败不会影响 Ozon 数据。</p></div></div>{props.jobs.length === 0 ? <div className="source-empty">还没有 Wordstat 任务</div> : <div className="job-list">{props.jobs.map((job) => <div key={job.id}><span className={`job-status job-status--${job.status}`}>{jobStatusLabel(job.status)}</span><p><strong>{job.completed + job.failed} / {job.total} 已处理</strong><span>{new Date(job.createdAt).toLocaleString("zh-CN")}</span></p><div className="job-progress"><span style={{ width: `${job.total > 0 ? ((job.completed + job.failed) / job.total) * 100 : 0}%` }} /></div>{job.failed > 0 && <small>{job.failed} 个失败</small>}</div>)}</div>}</article></section>;
}

function jobStatusLabel(status: Awaited<ReturnType<typeof fetchWordstatJobs>>[number]["status"]): string {
  return { queued: "排队中", running: "处理中", completed: "已完成", partial: "部分成功", failed: "失败" }[status];
}
