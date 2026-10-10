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
    ['the PageUp key', (log: HTMLElement) => fireEvent.keyDown(log, { key: 'PageUp' })],
    ['the Home key', (log: HTMLElement) => fireEvent.keyDown(log, { key: 'Home' })],
    ['the space key', (log: HTMLElement) => fireEvent.keyDown(log, { key: ' ' })],
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

  // 線は画面の背（ここでは 400px）の半分。半分より短ければ引かれただけ、半分ちょうどからは人が動かした
  it.each([
    [150, 'keeps following', 1300],
    [200, 'stops following', 400],
  ])('when the position moves %ipx up without a person touching the log, %s', (up, _, end) => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    log.scrollTop = 600 - up;
    fireEvent.scroll(log);
    size.scrollHeight = 1300;
    grow();

    expect(log.scrollTop).toBe(end);
  });

  // 人が触れたと見るのは、上へ動く前の 1 秒以内だけ（#288）
  it.each([
    [1000, 'stops following', 578],
    [1001, 'keeps following', 1112],
  ])('when the end pulls the position up %i ms after the wheel, %s', (after, _, end) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    fireEvent.wheel(log);
    now.mockReturnValue(10_000 + after);
    log.scrollTop = 578;
    size.scrollHeight = 1112;
    fireEvent.scroll(log);
    grow();

    expect(log.scrollTop).toBe(end);
    now.mockRestore();
  });

  // 行の中のボタンを押した・文字を打ったのは、ログを動かそうとしたのではない
  it.each([
    ['a press on a button in a row', () => fireEvent.pointerDown(screen.getByText('行'))],
    ['a key that does not scroll', (log: HTMLElement) => fireEvent.keyDown(log, { key: 'a' })],
  ])('keeps following when the end pulls the position up a little after %s', (_, press) => {
    const { log, size } = renderLog();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    press(log);
    log.scrollTop = 578;
    size.scrollHeight = 1112;
    fireEvent.scroll(log);
    grow();

    expect(log.scrollTop).toBe(1112);
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

// 上を読んでいる間に行が増えたら、下端に「新しい行」の印を出す。末尾にいる間は出さない
describe('ChatLog and the marker for new rows', () => {
  function renderWithKey() {
    const view = (key: number) => (
      <ChatLog followKey={key}>
        <p>行</p>
      </ChatLog>
    );
    const { rerender } = render(view(1));
    const log = screen.getByRole('log');
    const size = { scrollHeight: 1000, clientHeight: 400 };
    sizeOf(log, size);
    return { log, size, rowsArrive: (key: number) => rerender(view(key)) };
  }
  const marker = () => screen.queryByRole('button', { name: '新しい行へ' });

  it('shows no marker while following the end, however many rows arrive', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);

    size.scrollHeight = 1200;
    rowsArrive(2);
    size.scrollHeight = 1400;
    rowsArrive(3);

    expect(marker()).toBeNull();
    expect(log.scrollTop).toBe(1400);
  });

  it('shows the marker when rows arrive while a person reads above, and goes to the end when pressed', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    expect(marker()).toBeNull();

    size.scrollHeight = 1200;
    rowsArrive(2);
    expect(log.scrollTop).toBe(100);
    const button = marker();
    expect(button).not.toBeNull();

    fireEvent.click(button!);
    fireEvent.scroll(log);
    expect(log.scrollTop).toBe(1200);
    expect(marker()).toBeNull();
    // 戻ったあとは、また末尾を追う
    size.scrollHeight = 1500;
    grow();
    expect(log.scrollTop).toBe(1500);
  });

  // 印は押すと消えるので、押した所にフォーカスを残せない。ログへ移す: 移さないとフォーカスが body に落ち、キーボードでは
  // どこにいるか分からなくなるため
  it('moves the focus to the log when the marker that held it goes away', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    size.scrollHeight = 1200;
    rowsArrive(2);
    const button = marker()!;
    button.focus();

    fireEvent.click(button);

    expect(marker()).toBeNull();
    expect(document.activeElement).toBe(log);
  });

  it('takes the marker away once a person scrolls back down to the end', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    size.scrollHeight = 1200;
    rowsArrive(2);
    expect(marker()).not.toBeNull();

    log.scrollTop = 800;
    fireEvent.scroll(log);

    expect(marker()).toBeNull();
  });

  it('keeps the marker while a person scrolls down without reaching the end', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    size.scrollHeight = 1200;
    rowsArrive(2);

    log.scrollTop = 300;
    fireEvent.scroll(log);

    expect(marker()).not.toBeNull();
  });

  it('shows no marker when the log is drawn again without new rows', () => {
    const { log, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    rowsArrive(1);

    expect(marker()).toBeNull();
  });

  // 押した直後から追う: 末尾へ動かした知らせ（scroll）は、次の行より遅れて届くことがある
  it('follows the end right after the marker is pressed, before the scroll is reported', () => {
    const { log, size, rowsArrive } = renderWithKey();
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    size.scrollHeight = 1200;
    rowsArrive(2);

    fireEvent.click(marker()!);
    expect(marker()).toBeNull();
    size.scrollHeight = 1400;
    rowsArrive(3);

    expect(log.scrollTop).toBe(1400);
    expect(marker()).toBeNull();
  });
});
