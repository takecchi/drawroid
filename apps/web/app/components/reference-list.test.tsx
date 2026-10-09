// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReferenceList, type Reference } from './reference-list';

afterEach(cleanup);

function reference(refId: string, overrides: Partial<Reference> = {}): Reference {
  return {
    refId,
    receivedAt: '2026-01-01T00:00:00.000Z',
    mediaType: 'image/png',
    previewUrl: `/api/files/jobs/j1/refs/${refId}.preview.webp`,
    ...overrides,
  };
}

describe('ReferenceList', () => {
  it('shows each image a human attached, in the order received, with the words they added', () => {
    render(
      <ReferenceList
        references={[
          reference('000001', { note: 'この構図で' }),
          reference('000002', { note: '服はこれ' }),
        ]}
      />,
    );

    const images = screen.getAllByRole('img');
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      '/api/files/jobs/j1/refs/000001.preview.webp',
      '/api/files/jobs/j1/refs/000002.preview.webp',
    ]);
    expect(screen.getByText('この構図で')).toBeTruthy();
    expect(screen.getByText('服はこれ')).toBeTruthy();
    expect(screen.getAllByText('人間が添えた参照画像')).toHaveLength(2);
  });

  it('shows the gist and the call that looked at the image, or that it is still waiting', () => {
    render(
      <ReferenceList
        references={[
          reference('000001', { gist: '白いワンピースの立ち姿', sentInCall: 'call-0001' }),
          reference('000002'),
        ]}
      />,
    );

    expect(screen.getByText(/白いワンピースの立ち姿/)).toBeTruthy();
    expect(screen.getByText(/次の回の境目で/)).toBeTruthy();
    // 呼び出しの ID は作り手向けなので、閉じた「詳しく」の中に畳む
    const details = screen.getByText('call-0001').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('詳しく');
    expect(screen.getAllByText('詳しく')).toHaveLength(1);
  });

  it('says so when no image is attached', () => {
    render(<ReferenceList references={[]} />);

    expect(screen.getByText('まだ参照画像は無い。')).toBeTruthy();
  });
});
