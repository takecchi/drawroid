import { isApiError, runDoctor, type DoctorResponse } from '@drawroid/swr';
import { Badge, Button, ErrorNote, Muted, OkNote, Section, Spinner, WarnNote } from '@drawroid/ui';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

type State =
  | { step: 'idle' }
  | { step: 'running' }
  | { step: 'done'; report: DoctorResponse['report'] }
  | { step: 'failed'; message: string };

/**
 * 設定の画面の「確かめる」。ターミナルの drawroid doctor と同じ確かめ（設定ファイル・バックエンド・LLM・web の配り先）を走らせ、
 * 項目ごとに「よい／足りない」と、足りないときにすることを出す。何も書き換えない
 */
export function DoctorCheck() {
  const [state, setState] = useState<State>({ step: 'idle' });
  const outcomeRef = useRef<HTMLDivElement>(null);

  // 終わったら結果へフォーカスを移す: このボタンは画面のいちばん下にあり、結果は画面の外に出るので、移さないと押しても何も起きないように見える
  useEffect(() => {
    if (state.step === 'done' || state.step === 'failed') outcomeRef.current?.focus();
  }, [state.step]);

  async function check() {
    setState({ step: 'running' });
    try {
      const { report } = await runDoctor();
      setState({ step: 'done', report });
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setState({ step: 'failed', message: caught.message });
    }
  }

  return (
    <Section
      title="まとめて確かめる"
      action={
        <Button loading={state.step === 'running'} onClick={() => void check()}>
          確かめる
        </Button>
      }
    >
      <Muted>
        設定ファイル・画像のバックエンド・LLM・web の配り先を一度に確かめる。LLM
        には短い呼び出しを1回送る（ターミナルの drawroid doctor と同じ確かめ）。
      </Muted>
      {state.step === 'running' && (
        <Spinner label="確かめています…（LLM の返事を待つので、時間がかかることがある）" />
      )}
      <div ref={outcomeRef} tabIndex={-1} className="outline-none">
        {state.step === 'failed' && <ErrorNote>確かめられなかった: {state.message}</ErrorNote>}
        {state.step === 'done' && <DoctorResult report={state.report} />}
      </div>
    </Section>
  );
}

function DoctorResult({ report }: { report: DoctorResponse['report'] }) {
  return (
    <div className="space-y-3">
      {report.lacking === 0 ? (
        <OkNote>
          すべてよい。会話から描き始められる。{' '}
          {/* 確かめたあと、そのまま描き始められるように、会話への道を置く */}
          <Link to="/" className="underline underline-offset-2">
            会話へ
          </Link>
        </OkNote>
      ) : (
        <WarnNote>
          足りないものが {report.lacking} つある。「すること」を上から順に直して、もう一度確かめる。
        </WarnNote>
      )}
      {report.sections.map((section) => (
        <section key={section.title} aria-label={section.title} className="space-y-1">
          <h3 className="text-sm font-semibold">{section.title}</h3>
          <ul className="space-y-1">
            {section.items.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <Badge tone={item.ok ? 'ok' : 'warn'}>{item.ok ? 'よい' : '足りない'}</Badge>
                <div className="min-w-0 break-words">
                  <p>{item.what}</p>
                  {item.todo !== undefined && (
                    <p className="text-muted-foreground">すること: {item.todo}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
