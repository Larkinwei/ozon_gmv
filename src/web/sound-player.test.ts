// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENABLED_KEY = "gmv.dashboard.sound_enabled";

interface FakeAudio {
  preload: string;
  volume: number;
  currentTime: number;
  play: ReturnType<typeof vi.fn>;
}

function stubAudio(): FakeAudio {
  const audio: FakeAudio = {
    preload: "",
    volume: 0,
    currentTime: 0,
    play: vi.fn(async () => undefined),
  };
  vi.stubGlobal("Audio", vi.fn(() => audio));
  return audio;
}

type SoundPlayerModule = typeof import("./sound-player");

/** Each test gets a fresh module instance so the singleton state never leaks. */
async function freshSoundPlayer(): Promise<SoundPlayerModule> {
  vi.resetModules();
  return import("./sound-player");
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("soundPlayer settings", () => {
  it("defaults to enabled and uses the bundled MP3", async () => {
    const { ORDER_SOUND_URL, soundPlayer } = await freshSoundPlayer();
    expect(soundPlayer.isEnabled()).toBe(true);
    expect(ORDER_SOUND_URL).toBe("/sounds/order-notification.mp3");
  });

  it("persists the enabled flag", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    soundPlayer.setEnabled(false);
    expect(window.localStorage.getItem(ENABLED_KEY)).toBe("false");
    expect(soundPlayer.isEnabled()).toBe(false);
  });

  it("notifies subscribers when the switch changes", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    const listener = vi.fn();
    soundPlayer.subscribe(listener);
    soundPlayer.setEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("soundPlayer.play", () => {
  it("does not play when disabled", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    soundPlayer.setEnabled(false);
    const audio = stubAudio();
    soundPlayer.unlock();
    expect(soundPlayer.play()).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("plays the bundled MP3 after the page has been unlocked", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    const audio = stubAudio();
    soundPlayer.unlock();
    audio.currentTime = 3;
    expect(soundPlayer.play()).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("silently skips when the audio element is unavailable", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    vi.stubGlobal("Audio", vi.fn(() => { throw new Error("unsupported"); }));
    soundPlayer.unlock();
    expect(() => soundPlayer.play()).not.toThrow();
    expect(soundPlayer.play()).toBe(false);
  });

  it("enforces a cooldown between order alerts", async () => {
    const { soundPlayer } = await freshSoundPlayer();
    vi.useFakeTimers();
    const audio = stubAudio();
    soundPlayer.unlock();
    expect(soundPlayer.play()).toBe(true);
    expect(soundPlayer.play()).toBe(false);
    vi.advanceTimersByTime(1600);
    expect(soundPlayer.play()).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
