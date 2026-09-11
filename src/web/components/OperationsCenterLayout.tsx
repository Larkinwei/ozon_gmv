import { BarChart3, ChevronDown, ClipboardList, Menu, PackagePlus } from "lucide-react";
import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { AppNav } from "./AppNav";

interface OperationsNavLink {
  label: string;
  to: string;
  icon: typeof BarChart3;
}

const operationsNavGroups: Array<{ label: string; items: OperationsNavLink[] }> = [
  {
    label: "商品分析",
    items: [{ label: "选品分析", to: "/operations/selection", icon: BarChart3 }],
  },
  {
    label: "商品发布",
    items: [
      { label: "商品上架", to: "/operations/publish", icon: PackagePlus },
      { label: "发布任务", to: "/operations/publish/tasks", icon: ClipboardList },
    ],
  },
];

/** Keeps the operations sub-navigation in one place across all product workflows. */
export default function OperationsCenterLayout(): React.JSX.Element {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  function isNavLinkActive(to: string): boolean {
    if (to === "/operations/publish") return location.pathname === to || location.pathname.startsWith(`${to}/resell/`);
    return location.pathname === to;
  }

  function closeMobileMenu(): void {
    setMenuOpen(false);
  }

  return (
    <div className="admin-page operations-center-page">
      <a className="skip-link" href="#operations-center-main">跳到主要内容</a>
      <header className="admin-header">
        <Link className="brand-lockup" to="/dashboard"><div className="brand-mark" aria-hidden="true">O</div><div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div></Link>
        <AppNav />
      </header>
      <div className="operations-center-mobile-toolbar">
        <button className="operations-center-mobile-toggle" type="button" aria-expanded={menuOpen} aria-controls="operations-center-navigation" onClick={() => setMenuOpen((current) => !current)}>
          <Menu size={17} aria-hidden="true" />商品运营菜单<ChevronDown className={menuOpen ? "is-open" : undefined} size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="operations-center-shell">
        <aside className={`operations-center-sidebar${menuOpen ? " is-open" : ""}`} id="operations-center-navigation" aria-label="运营中心模块">
          <div className="operations-center-sidebar-heading">
            <p className="eyebrow">OPERATIONS CENTER</p>
            <h2>运营中心</h2>
            <p>集中处理商品分析与发布动作。</p>
          </div>
          <nav className="operations-center-nav">
            {operationsNavGroups.map((group) => (
              <div className="operations-center-nav-group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map((item) => {
                  const active = isNavLinkActive(item.to);
                  return <Link className={active ? "operations-center-nav-link is-active" : "operations-center-nav-link"} aria-current={active ? "page" : undefined} to={item.to} onClick={closeMobileMenu} key={item.to}><item.icon size={17} aria-hidden="true" /><span>{item.label}</span></Link>;
                })}
              </div>
            ))}
          </nav>
        </aside>
        <div className="operations-center-content" id="operations-center-main">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
