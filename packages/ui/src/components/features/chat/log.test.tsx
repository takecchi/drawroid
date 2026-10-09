// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatLog, SKIP_OFFSCREEN_AFTER_ROWS } from './log';

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

  it('follows again when a person scrolls back down to the end, even if the rows there grew as they came into view', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    // 末尾（ここでは 600）へ戻したが、その出来事が届くまでに、画面に入った行が見積もりより高く描かれた
    log.scrollTop = 600;
    size.scrollHeight = 1100;
    fireEvent.scroll(log);

    // 背が伸びた知らせ（ResizeObserver）は、この出来事より先に来ていて、もう来ない
    expect(log.scrollTop).toBe(1100);
    size.scrollHeight = 1300;
    grow();
    expect(log.scrollTop).toBe(1300);
  });

  it('keeps following when the rows above shrink and pull the position up with them', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    // 画面の外の行の描画を飛ばし始め、上の行が見積もりの背へ縮んだ: 人は何もしていないのに位置が上へ動く
    // 縮んだあとの位置は、末尾から 50px（追う範囲の外）
    size.scrollHeight = 950;
    log.scrollTop = 500;
    fireEvent.scroll(log);
    size.scrollHeight = 1200;
    grow();

    expect(log.scrollTop).toBe(1200);
  });

  // ブラウザは位置を末尾までに収める。行を入れ替える途中で背が一瞬縮んで測られると、位置が新しい末尾へ引かれ、
  // その動きの知らせが届くまでに新しい行で背が伸びる。「位置は上がり、背は伸びた」と、人が上へ戻したのと同じに見える
  // （Chromium の長い会話で、新しい行のあと末尾から 22px 引かれて追うのをやめ、120〜273px 手前に置き去りにされた）
  it('keeps following when the end pulled the position up a little without a person touching the log', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    log.scrollTop = 578;
    size.scrollHeight = 1112;
    fireEvent.scroll(log);
    grow();

    expect(log.scrollTop).toBe(1112);
  });

  it.each([
    ['the wheel', (log: HTMLElement) => fireEvent.wheel(log)],
    ['a touch', (log: HTMLElement) => fireEvent.touchMove(log)],
    ['a key', (log: HTMLElement) => fireEvent.keyDown(log, { key: 'ArrowUp' })],
    ['the scroll bar', (log: HTMLElement) => fireEvent.pointerDown(log)],
  ])('stops following when a person scrolls up a short way from the end with %s', (_, touch) => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    // 末尾を見ている範囲（48px）の外まで、画面の背の半分より短く戻す
    touch(log);
    log.scrollTop = 450;
    fireEvent.scroll(log);
    size.scrollHeight = 1300;
    grow();

    expect(log.scrollTop).toBe(450);
  });

  it('stops following when the position jumps far up from the end without a person touching the log, as find in page does', () => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    log.scrollTop = 350;
    fireEvent.scroll(log);
    size.scrollHeight = 1300;
    grow();

    expect(log.scrollTop).toBe(350);
  });
});

describe('ChatLog in a long conversation', () => {
  const view = (rowCount: number) => (
    <ChatLog followKey={rowCount} rowCount={rowCount}>
      <p>行</p>
    </ChatLog>
  );
  const skipping = () =>
    screen.getByRole('log').firstElementChild?.hasAttribute('data-skip-offscreen') ?? false;

  it('does not skip drawing the rows out of view while the conversation is short', () => {
    render(view(SKIP_OFFSCREEN_AFTER_ROWS));
    expect(skipping()).toBe(false);
  });

  it('starts skipping once the conversation grows past the line while following the end', () => {
    const { rerender } = render(view(SKIP_OFFSCREEN_AFTER_ROWS));
    rerender(view(SKIP_OFFSCREEN_AFTER_ROWS + 1));
    expect(skipping()).toBe(true);
  });

  it('waits to start skipping while a person reads above, until they come back to the end', () => {
    const { rerender } = render(view(SKIP_OFFSCREEN_AFTER_ROWS));
    const log = screen.getByRole('log');
    const size = { scrollHeight: 1000, clientHeight: 400 };
    sizeOf(log, size);
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    rerender(view(SKIP_OFFSCREEN_AFTER_ROWS + 1));
    expect(skipping()).toBe(false);

    log.scrollTop = 600;
    fireEvent.scroll(log);
    rerender(view(SKIP_OFFSCREEN_AFTER_ROWS + 2));
    expect(skipping()).toBe(true);
  });
});
