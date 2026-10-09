// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { SiteNav } from './site-nav';

afterEach(cleanup);

const hrefOf = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

describe('SiteNav', () => {
  it('leads to every page, including the memory, from one bar', () => {
    render(
      <MemoryRouter>
        <SiteNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(hrefOf('生成')).toBe('/');
    expect(hrefOf('依頼')).toBe('/jobs/new');
    expect(hrefOf('ジョブ')).toBe('/jobs');
    expect(hrefOf('記憶')).toBe('/memory');
  });
});
