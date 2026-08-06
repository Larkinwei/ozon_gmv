import { BarChart3, LogOut, Maximize2, Menu, Minimize2, Settings, Store, X } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { logout } from "../api";

interface AppNavProps {
  compact?: boolean;
}

export function AppNav({ compact = false }: AppNavProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [menuOpen, setMenuOpen] = useState(false);
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      navigate("/login");
    },
  });

  async function toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setFullscreen(false);
      return;
    }
    await document.documentElement.requestFullscreen();
    setFullscreen(true);
  }

  return (
    <nav className={compact ? "app-nav app-nav--compact" : "app-nav"} aria-label="主导航">
      {!compact && (
        <>
          <Link className={location.pathname === "/dashboard" ? "nav-link is-active" : "nav-link"} to="/dashboard">
            <BarChart3 size={18} aria-hidden="true" /> 运营总览
          </Link>
          <Link className={location.pathname === "/stores" ? "nav-link is-active" : "nav-link"} to="/stores">
            <Store size={18} aria-hidden="true" /> 店铺管理
          </Link>
          <Link className={location.pathname === "/settings" ? "nav-link is-active" : "nav-link"} to="/settings">
            <Settings size={18} aria-hidden="true" /> 本机设置
          </Link>
        </>
      )}
      <button className="icon-button" type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "退出全屏" : "进入全屏"}>
        {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
      </button>
      {!compact && (
        <>
          <button className="icon-button desktop-logout" type="button" onClick={() => logoutMutation.mutate()} aria-label="退出登录">
            <LogOut size={19} />
          </button>
          <button className="icon-button mobile-menu-button" type="button" aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen((value) => !value)} aria-label={menuOpen ? "关闭导航菜单" : "打开导航菜单"}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          {menuOpen && (
            <div className="mobile-nav-drawer" id="mobile-navigation">
              <Link className={location.pathname === "/dashboard" ? "is-active" : ""} to="/dashboard" onClick={() => setMenuOpen(false)}><BarChart3 size={18} />运营总览</Link>
              <Link className={location.pathname === "/stores" ? "is-active" : ""} to="/stores" onClick={() => setMenuOpen(false)}><Store size={18} />店铺管理</Link>
              <Link className={location.pathname === "/settings" ? "is-active" : ""} to="/settings" onClick={() => setMenuOpen(false)}><Settings size={18} />本机设置</Link>
              <button type="button" onClick={() => logoutMutation.mutate()}><LogOut size={18} />退出登录</button>
            </div>
          )}
        </>
      )}
    </nav>
  );
}
