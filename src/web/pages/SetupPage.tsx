import { CheckCircle2, Database, Eye, EyeOff, LockKeyhole, Server } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { initializeSetup } from "../api";

/** Guides the installer-computer user through creating the only administrator. */
export default function SetupPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const mutation = useMutation({
    mutationFn: () => initializeSetup(username, password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      navigate("/dashboard");
    },
  });

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (password !== confirmation) {
      return;
    }
    mutation.mutate();
  }

  const mismatch = confirmation.length > 0 && password !== confirmation;
  return (
    <main className="login-page">
      <section className="login-visual" aria-label="初始化说明">
        <div className="brand-lockup login-brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div><p className="eyebrow">OZON LOCAL EDITION</p><h1>GMV 指挥中心</h1></div>
        </div>
        <div className="login-message">
          <span className="status-pill status-pill--healthy"><CheckCircle2 size={15} /> 本地服务已就绪</span>
          <h2>只需最后一步，创建管理员。</h2>
          <p>账号、店铺和订单只保存在这台电脑。升级安装包会保留数据，不需要重复配置。</p>
        </div>
        <div className="login-proof-grid">
          <div><Database size={20} /><strong>SQLite</strong><span>本机数据库</span></div>
          <div><Server size={20} /><strong>常驻</strong><span>开机自动运行</span></div>
          <div><LockKeyhole size={20} /><strong>AES</strong><span>API 密钥加密</span></div>
        </div>
      </section>

      <section className="login-form-section">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card__icon"><LockKeyhole size={24} aria-hidden="true" /></div>
          <p className="eyebrow">FIRST-TIME SETUP</p>
          <h2>创建管理员</h2>
          <p className="form-intro">此操作只能在安装电脑上完成，创建后不可再次初始化。</p>
          <label className="field">
            <span>管理员用户名</span>
            <input autoComplete="username" minLength={3} maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>密码</span>
            <span className="password-field">
              <input autoComplete="new-password" type={showPassword ? "text" : "password"} minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
            <small>至少 10 个字符，建议同时包含数字和符号。</small>
          </label>
          <label className="field">
            <span>确认密码</span>
            <input autoComplete="new-password" type="password" minLength={10} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
          </label>
          {mismatch && <div className="field-error" role="alert">两次输入的密码不一致</div>}
          {mutation.error && <div className="field-error" role="alert">{mutation.error.message}</div>}
          <button className="primary-button login-button" type="submit" disabled={mutation.isPending || mismatch}>
            {mutation.isPending ? "正在初始化…" : "完成初始化"}
          </button>
        </form>
      </section>
    </main>
  );
}
