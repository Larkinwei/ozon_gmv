import type { StoreView } from "../../shared/contracts";
import { HIDDEN_PLACEHOLDER } from "../dashboard-privacy";
import { formatBeijingTime, syncHealthLabel } from "../format";
import { HealthIcon } from "./StatusPill";

export function SyncStrip({ stores, privacyHidden = false }: { stores: StoreView[]; privacyHidden?: boolean }): React.JSX.Element {
  return (
    <section className="sync-strip" aria-label="店铺同步状态">
      <div className="sync-strip__label">
        <span className="eyebrow">SYNC HEALTH</span>
        <strong>数据新鲜度</strong>
      </div>
      <div className="sync-store-list">
        {stores.map((store) => (
          <div className={`sync-store sync-store--${store.syncHealth}`} key={store.id}>
            <HealthIcon health={store.syncHealth} />
            <span>{privacyHidden ? HIDDEN_PLACEHOLDER : store.name}</span>
            <small>
              {store.lastSyncFinishedAt ? `${formatBeijingTime(store.lastSyncFinishedAt)} 更新` : syncHealthLabel(store.syncHealth)}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

