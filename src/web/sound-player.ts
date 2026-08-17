import { useSyncExternalStore } from "react";

const ENABLED_KEY = "gmv.dashboard.sound_enabled";
/** The supplied notification sound is bundled with the web build. */
export const ORDER_SOUND_URL = "/sounds/order-notification.mp3";
/** Minimum interval between two audible plays, so a burst of orders stays pleasant. */
const COOLDOWN_MS = 1500;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / disabled storage: keep the in-memory state only.
  }
}

type Listener = () => void;

/**
 * Client-side order-alert sound engine.
 *
 * The audio element is created lazily after a user gesture. This keeps browser
 * autoplay policies predictable while allowing the same bundled MP3 on every
 * platform. `play()` handles a rejected promise silently because a browser may
 * still block audio until the user interacts with the page.
 */
class SoundPlayer {
  private readonly listeners = new Set<Listener>();
  private audio: HTMLAudioElement | null = null;
  private lastPlayedAt = 0;
  private enabled: boolean;
  private enabledSnapshot: boolean;

  public constructor() {
    this.enabled = readStorage(ENABLED_KEY) !== "false";
    this.enabledSnapshot = this.enabled;
  }

  public subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getEnabledSnapshot = (): boolean => this.enabledSnapshot;

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(value: boolean): void {
    if (this.enabled === value) {
      return;
    }
    this.enabled = value;
    this.enabledSnapshot = value;
    writeStorage(ENABLED_KEY, String(value));
    if (value) {
      this.unlock();
    }
    this.notify();
  }

  /**
   * Creates the audio element from a user-gesture handler. It does not play
   * anything by itself, so enabling the setting remains silent.
   */
  public unlock(): void {
    if (typeof window === "undefined" || this.audio) {
      return;
    }
    try {
      this.audio = new Audio(ORDER_SOUND_URL);
      this.audio.preload = "auto";
      this.audio.volume = 1;
    } catch {
      this.audio = null;
    }
  }

  /** Plays the fixed supplied MP3. Returns false when skipped or unavailable. */
  public play(): boolean {
    if (!this.enabled) {
      return false;
    }
    const now = Date.now();
    if (now - this.lastPlayedAt < COOLDOWN_MS) {
      return false;
    }
    const audio = this.audio;
    // Autoplay blocked (no audio element yet): skip silently.
    if (!audio) {
      return false;
    }
    this.lastPlayedAt = now;
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }
}

export const soundPlayer = new SoundPlayer();

/** Subscribes a component to the sound-enabled flag. */
export function useSoundEnabled(): boolean {
  return useSyncExternalStore(
    soundPlayer.subscribe,
    soundPlayer.getEnabledSnapshot,
    soundPlayer.getEnabledSnapshot,
  );
}
