import { Volume2, VolumeX } from "lucide-react";

import { soundPlayer, useSoundEnabled } from "../sound-player";

/** Header quick toggle for the new-order alert sound (works on admin and wallboard pages). */
export function SoundToggle(): React.JSX.Element {
  const enabled = useSoundEnabled();
  return (
    <button
      className={enabled ? "icon-button sound-toggle is-active" : "icon-button sound-toggle"}
      type="button"
      onClick={() => soundPlayer.setEnabled(!enabled)}
      aria-pressed={enabled}
      title={enabled ? "新订单提示音：开启（点击关闭）" : "新订单提示音：关闭（点击开启）"}
      aria-label={enabled ? "关闭新订单提示音" : "开启新订单提示音"}
    >
      {enabled ? <Volume2 size={19} aria-hidden="true" /> : <VolumeX size={19} aria-hidden="true" />}
    </button>
  );
}
