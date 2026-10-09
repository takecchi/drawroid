// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatLog } from './log';

/** 背が伸びたことを試験から知らせる ResizeObserver の代わり */
let grow: () => void = () => {};
class FakeResizeObserver {
  constructor(callback: () => void) {
    grow = callback;
  }
  observe() {}
  disconnect() {}
}

/** jsdom はレイアウトしないので、背の高さを手で決める */
function sizeOf(element: HTMLElement, size: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => size.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => size.clientHeight,
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLog() {
  render(
    <ChatLog followKey={1}>
      <p>行</p>
    </ChatLog>,
  );
  const log = screen.getByRole('log');
  const size = { scrollHeight: 1000, clientHeight: 400 };
  sizeOf(log, size);
  return { log, size };
}

describe('ChatLog', () => {
  it('keeps to the end when the rows grow taller, such as when an image loads', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    size.scrollHeight = 1400;
    grow();

    expect(log.scrollTop).toBe(1400);
  });

  it('keeps following when the rows grew before the scroll to the end was reported', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    // 末尾へ動かした出来事が届く前に、画像の背が伸びた: 人は何もしていないのに末尾から遠く見える
    size.scrollHeight = 1214;
    fireEvent.scroll(log);
    grow();

    expect(log.scrollTop).toBe(1214);
  });

  it('stops following once a person scrolls up, and follows again after coming back down', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    size.scrollHeight = 1400;
    grow();
    expect(log.scrollTop).toBe(100);

    log.scrollTop = 1000;
    fireEvent.scroll(log);
    size.scrollHeight = 1800;
    grow();
    expect(log.scrollTop).toBe(1800);
  });
});
