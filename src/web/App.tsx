import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";

import { fetchRuntime, fetchSession } from "./api";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SelectionPage = lazy(() => import("./pages/SelectionPage"));
const OperationsCenterLayout = lazy(() => import("./components/OperationsCenterLayout"));
const PublishTasksPage = lazy(() => import("./pages/PublishTasksPage"));
const FinanceAnalysisPage = lazy(() => import("./pages/FinanceAnalysisPage"));
const AiPage = lazy(() => import("./pages/AiPage"));
const ResellPage = lazy(() => import("./pages/ResellPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const StoresPage = lazy(() => import("./pages/StoresPage"));

function AppLoading(): React.JSX.Element {
  return (
    <main className="app-loading" aria-busy="true" aria-label="正在加载应用">
      <div className="brand-mark" aria-hidden="true">O</div>
      <div className="loading-line" />
    </main>
  );
}

function PairingRequired(): React.JSX.Element {
  return (
    <main className="pairing-required">
      <div className="brand-mark" aria-hidden="true">O</div>
      <h1>大屏尚未配对</h1>
      <p>请在安装电脑的“本机设置”中生成一次性局域网配对链接，再用本设备打开。</p>
    </main>
  );
}

/** Redirects a legacy route while keeping the user's filters and tab state. */
function LegacyRouteRedirect(props: { to: string }): React.JSX.Element {
  const location = useLocation();
  return <Navigate to={`${props.to}${location.search}`} replace />;
}

/** Moves the former selection task tab to its new publish-task destination. */
function LegacySelectionRedirect(): React.JSX.Element {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const taskTab = searchParams.get("tab") === "resell-tasks";
  const target = taskTab ? "/operations/publish/tasks" : "/operations/selection";
  return <Navigate to={`${target}${location.search}`} replace />;
}

/** Redirects legacy SKU links without losing the encoded product identifier. */
function LegacyResellRedirect(): React.JSX.Element {
  const { sku } = useParams<{ sku: string }>();
  const location = useLocation();
  const encodedSku = encodeURIComponent(sku ?? "");
  return <Navigate to={`/operations/publish/resell/${encodedSku}${location.search}`} replace />;
}

export function App(): React.JSX.Element {
  const location = useLocation();
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: fetchRuntime, retry: false });
  const session = useQuery({
    queryKey: ["session", runtime.data?.role],
    queryFn: fetchSession,
    enabled: Boolean(runtime.data),
    retry: false,
  });

  if (runtime.isLoading || session.isLoading || !runtime.data) {
    return <AppLoading />;
  }
  if (runtime.data.role === "wallboard") {
    if (!session.data?.authenticated) {
      return <PairingRequired />;
    }
    return (
      <Suspense fallback={<AppLoading />}>
        <Routes>
          <Route path="/wallboard" element={<DashboardPage wallboard />} />
          <Route path="*" element={<Navigate to="/wallboard" replace />} />
        </Routes>
      </Suspense>
    );
  }
  if (session.data?.setupRequired) {
    return (
      <Suspense fallback={<AppLoading />}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </Suspense>
    );
  }
  if (!session.data?.authenticated) {
    const currentPath = `${location.pathname}${location.search}`;
    const loginTarget = location.pathname === "/login"
      ? currentPath
      : `/login?next=${encodeURIComponent(currentPath)}`;
    return (
      <Suspense fallback={<AppLoading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to={loginTarget} replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<AppLoading />}>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/wallboard" element={<DashboardPage wallboard />} />
        <Route path="/stores" element={<StoresPage />} />
        <Route path="/operations" element={<OperationsCenterLayout />}>
          <Route index element={<Navigate to="selection" replace />} />
          <Route path="selection" element={<SelectionPage />} />
          <Route path="publish" element={<ResellPage />} />
          <Route path="publish/tasks" element={<PublishTasksPage />} />
          <Route path="publish/resell/:sku" element={<ResellPage />} />
          <Route path="finance" element={<FinanceAnalysisPage />} />
          <Route path="ai" element={<AiPage />} />
        </Route>
        <Route path="/selection" element={<LegacySelectionRedirect />} />
        <Route path="/selection/publish" element={<LegacyRouteRedirect to="/operations/publish" />} />
        <Route path="/selection/resell/:sku" element={<LegacyResellRedirect />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
