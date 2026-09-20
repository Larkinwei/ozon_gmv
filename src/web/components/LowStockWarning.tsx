import { AlertTriangle, Package, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { InventoryLowStockAlert } from "../../shared/contracts";
import { acknowledgeInventoryAlerts, fetchInventoryAlerts } from "../api";

interface LowStockWarningProps {
  incomingAlert?: InventoryLowStockAlert | null;
}

export function LowStockWarning({ incomingAlert }: LowStockWarningProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const alertsQuery = useQuery({ queryKey: ["inventory-alerts"], queryFn: fetchInventoryAlerts });
  const [alerts, setAlerts] = useState<InventoryLowStockAlert[]>([]);
  const acknowledgeMutation = useMutation({
    mutationFn: () => acknowledgeInventoryAlerts(alerts.map((alert) => alert.id)),
    onSuccess: () => {
      setAlerts([]);
      void queryClient.invalidateQueries({ queryKey: ["inventory-alerts"] });
    },
  });

  useEffect(() => {
    if (alertsQuery.data) setAlerts(alertsQuery.data.items);
  }, [alertsQuery.data]);

  useEffect(() => {
    if (!incomingAlert) return;
    setAlerts((current) => current.some((alert) => alert.id === incomingAlert.id)
      ? current.map((alert) => alert.id === incomingAlert.id ? incomingAlert : alert)
      : [...current, incomingAlert]);
  }, [incomingAlert]);

  if (alerts.length === 0) return null;
  return (
    <div className="low-stock-warning-backdrop" role="presentation">
      <section className="low-stock-warning" role="alertdialog" aria-modal="true" aria-labelledby="low-stock-warning-title">
        <div className="low-stock-warning__heading">
          <div className="low-stock-warning__icon" aria-hidden="true"><AlertTriangle size={24} /></div>
          <div>
            <p className="eyebrow">INVENTORY WARNING</p>
            <h2 id="low-stock-warning-title">库存不足提醒</h2>
            <p>以下商品库存已低于 50 件，请及时补货。</p>
          </div>
        </div>
        <div className="low-stock-warning__list">
          {alerts.map((alert) => (
            <div className="low-stock-warning__item" key={alert.id}>
              {alert.imageUrl ? <img src={alert.imageUrl} alt="" /> : <div className="low-stock-warning__placeholder" aria-hidden="true"><Package size={19} /></div>}
              <div className="low-stock-warning__item-main">
                <strong>{alert.productName}</strong>
                <span>{alert.storeName} · {alert.fulfillment} · SKU {alert.sku}</span>
              </div>
              <div className="low-stock-warning__stock"><strong>{alert.availableStock}</strong><span>可售库存</span></div>
            </div>
          ))}
        </div>
        {acknowledgeMutation.error && <p className="low-stock-warning__error" role="alert">关闭提醒失败，请重试。</p>}
        <button className="primary-button low-stock-warning__close" type="button" onClick={() => acknowledgeMutation.mutate()} disabled={acknowledgeMutation.isPending}>
          <X size={16} aria-hidden="true" />
          {acknowledgeMutation.isPending ? "关闭中…" : "关闭提醒"}
        </button>
      </section>
    </div>
  );
}
