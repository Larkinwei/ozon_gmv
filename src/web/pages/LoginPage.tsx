import { Activity, Eye, EyeOff, LockKeyhole, ShieldCheck, Store } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { login } from "../api";

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const loginMutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      navigate("/dashboard");
    },
  });

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    loginMutation.mutate();
  }

  return (
    <main className="login-page">
      <section className="login-visual" aria-label="产品介绍">
        <div className="brand-lockup login-brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div>
            <p className="eyebrow">OZON MULTI-STORE</p>
            <h1>GMV 指挥中心</h1>
          </div>
        </div>
        <div className="login-message">
          <span className="status-pill status-pill--healthy"><Activity size={15} /> 数据链路在线</span>
          <h2>所有店铺，一块屏幕，实时掌握。</h2>
          <p>用北京时间统一观察订单、GMV、取消与同步健康度。API 密钥仅加密保存在本机。</p>
        </div>
        <div className="login-proof-grid">
          <div><Store size={20} /><strong>20</strong><span>最多店铺</span></div>
          <div><Activity size={20} /><strong>60s</strong><span>全模式轮询</span></div>
          <div><ShieldCheck size={20} /><strong>AES</strong><span>密钥加密</span></div>
        </div>
      </section>

      <section className="login-form-section">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card__icon"><LockKeyhole size={24} aria-hidden="true" /></div>
          <p className="eyebrow">SECURE ACCESS</p>
          <h2>管理员登录</h2>
          <p className="form-intro">登录后可查看经营数据并管理店铺连接。</p>

          <label className="field">
            <span>用户名</span>
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label className="field">
            <span>密码</span>
            <span className="password-field">
              <input
                autoComplete="current-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>
          {loginMutation.error && <div className="field-error" role="alert">{loginMutation.error.message}</div>}
          <button className="primary-button login-button" type="submit" disabled={loginMutation.isPending}>
            {loginMutation.isPending ? "正在验证…" : "进入指挥中心"}
          </button>
          <small className="security-note"><ShieldCheck size={14} /> 会话使用 HttpOnly 安全 Cookie，有效期 8 小时</small>
        </form>
      </section>
    </main>
  );
}
