import { Page } from '@drawroid/ui';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { GenerationForm } from '../components/generation-form';

/** 設定の欄は「設定」（/settings）へ移した。前のリンク（/generate#llm など）は、その欄へ送る */
const MOVED_TO_SETTINGS = new Set(['#llm', '#backend', '#budgets']);

export default function Generate() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const moved = MOVED_TO_SETTINGS.has(hash);
  useEffect(() => {
    if (moved) void navigate(`/settings${hash}`, { replace: true });
  }, [moved, hash, navigate]);
  if (moved) return null;
  return (
    <Page title="手動で生成">
      <GenerationForm onStarted={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </Page>
  );
}
