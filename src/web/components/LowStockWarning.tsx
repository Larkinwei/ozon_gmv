import { AlertTriangle, Package, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { InventoryLowStockAlert } from "../../shared/contracts";
import { acknowledgeInventoryAlerts, fetchInventoryAlerts, snoozeInventorySku } from "../api";

interface LowStockWarningProps {
  incomingAlert?: InventoryLowStockAlert | null;
  previewAlerts?: InventoryLowStockAlert[];
  onPreviewClose?: () => void;
}

export function LowStockWarning({ incomingAlert, previewAlerts, onPreviewClose }: LowStockWarningProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const previewMode = previewAlerts !== undefined;
  const alertsQuery = useQuery({ queryKey: ["inventory-alerts"], queryFn: fetchInventoryAlerts, enabled: !previewMode });
  const [alerts, setAlerts] = useState<InventoryLowStockAlert[]>([]);
  const [previewHiddenIds, setPreviewHiddenIds] = useState<string[]>([]);
  const snoozeMutation = useMutation({
    mutationFn: ({ storeId, sku }: { storeId: string; sku: string }) => snoozeInventorySku(storeId, sku),
    onSuccess: (_result, { storeId, sku }) => {
      setAlerts((current) => current.filter((alert) => alert.storeId !== storeId || alert.sku !== sku));
      void queryClient.invalidateQueries({ queryKey: ["inventory-alerts"] });
    },
  });
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

  const visibleAlerts = previewMode
    ? previewAlerts.filter((alert) => !previewHiddenIds.includes(alert.id))
    : alerts;
  if (!visibleAlerts || visibleAlerts.length === 0) return null;
  return (
    <div className="low-stock-warning-backdrop" role="presentation">
      <section className="low-stock-warning" role="alertdialog" aria-modal="true" aria-labelledby="low-stock-warning-title">
        <div className="low-stock-warning__heading">
          <div className="low-stock-warning__icon" aria-hidden="true"><AlertTriangle size={24} /></div>
          <div>
            <p className="eyebrow">INVENTORY WARNING</p>
            <h2 id="low-stock-warning-title">库存不足提醒</h2>
            <p>以下商品库存已低于 {visibleAlerts[0]?.threshold ?? alertsQuery.data?.threshold ?? 30} 件，请及时补货。</p>
          </div>
        </div>
        <div className="low-stock-warning__list">
          {visibleAlerts.map((alert) => (
            <div className="low-stock-warning__item" key={alert.id}>
              {alert.imageUrl ? <img src={alert.imageUrl} alt="" /> : <div className="low-stock-warning__placeholder" aria-hidden="true"><Package size={19} /></div>}
              <div className="low-stock-warning__item-main">
                <strong>{alert.productName}</strong>
                <span>{alert.storeName} · {alert.fulfillment} · SKU {alert.sku}</span>
              </div>
              <div className="low-stock-warning__stock"><strong>{alert.availableStock}</strong><span>可售库存</span></div>
              <button
                className="secondary-button compact-button low-stock-warning__snooze"
                type="button"
                disabled={!previewMode && snoozeMutation.isPending && snoozeMutation.variables?.storeId === alert.storeId && snoozeMutation.variables.sku === alert.sku}
                onClick={() => previewMode
                  ? setPreviewHiddenIds((current) => [...current, alert.id])
                  : snoozeMutation.mutate({ storeId: alert.storeId, sku: alert.sku })}
              >
                {snoozeMutation.isPending && snoozeMutation.variables?.storeId === alert.storeId && snoozeMutation.variables.sku === alert.sku ? "处理中…" : "7天内不再提醒"}
              </button>
            </div>
          ))}
        </div>
        {snoozeMutation.error && !previewMode && <p className="low-stock-warning__error" role="alert">暂时无法忽略此 SKU，请重试。</p>}
        {acknowledgeMutation.error && !previewMode && <p className="low-stock-warning__error" role="alert">关闭提醒失败，请重试。</p>}
        <button className="primary-button low-stock-warning__close" type="button" onClick={() => previewMode ? onPreviewClose?.() : acknowledgeMutation.mutate()} disabled={!previewMode && acknowledgeMutation.isPending}>
          <X size={16} aria-hidden="true" />
          {!previewMode && acknowledgeMutation.isPending ? "关闭中…" : "关闭提醒"}
        </button>
      </section>
    </div>
  );
}
