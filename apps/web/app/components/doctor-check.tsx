import { isApiError, runDoctor } from '@drawroid/swr';
import { Badge, Button, ErrorNote, Muted, OkNote, Section, Spinner, WarnNote } from '@drawroid/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';

// 返事を、結果を描く前に確かめる: 200 でも体が壊れていると（report が無いなど）、描く途中で落ちて画面ごと消えるため
const answerSchema = z.object({
  report: z.object({
    lacking: z.number(),
    sections: z.array(
      z.object({
        title: z.string(),
        items: z.array(
          z.object({ ok: z.boolean(), what: z.string(), todo: z.string().optional() }),
        ),
      }),
    ),
  }),
});
type Report = z.infer<typeof answerSchema>['report'];

const UNREADABLE = '確かめの結果が読めなかった（drawroid の返事が想定の形ではない）';

type State =
  | { step: 'idle' }
  | { step: 'running' }
  | { step: 'done'; report: Report }
  | { step: 'failed'; message: string };

/**
 * 設定の画面の「確かめる」。ターミナルの drawroid doctor と同じ確かめ（設定ファイル・バックエンド・LLM・web の配り先）を走らせ、
 * 項目ごとに「よい／足りない」と、足りないときにすることを出す。何も書き換えない
 */
export function DoctorCheck() {
  const [state, setState] = useState<State>({ step: 'idle' });
  const outcomeRef = useRef<HTMLDivElement>(null);

  const buttonId = useId();

  // 終わったら結果へフォーカスを移す: このボタンは画面のいちばん下にあり、結果は画面の外に出るので、移さないと押しても何も起きないように見える。
  // 移すのは、フォーカスがまだボタンにあるか、どこにも無い（待つ間にボタンが押せなくなって body へ落ちた）ときだけ。
  // 待つ間に人がほかの欄へ移っていたら奪わない: 打っている途中の文字が、結果の箱に吸われるため
  useEffect(() => {
    if (state.step !== 'done' && state.step !== 'failed') return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.id === buttonId) {
      outcomeRef.current?.focus();
    }
  }, [state.step, buttonId]);

  async function check() {
    setState({ step: 'running' });
    let answer: unknown;
    try {
      answer = await runDoctor();
    } catch (caught) {
      // API の失敗でないもの（200 の体が JSON でない、など）も、待つ印を出したままにせず、読めなかったと出す
      setState({
        step: 'failed',
        message: isApiError(caught) ? `確かめられなかった: ${caught.message}` : UNREADABLE,
      });
      return;
    }
    const parsed = answerSchema.safeParse(answer);
    setState(
      parsed.success
        ? { step: 'done', report: parsed.data.report }
        : { step: 'failed', message: UNREADABLE },
    );
  }

  return (
    <Section
      title="まとめて確かめる"
      action={
        <Button id={buttonId} loading={state.step === 'running'} onClick={() => void check()}>
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
        {state.step === 'failed' && <ErrorNote>{state.message}</ErrorNote>}
        {state.step === 'done' && <DoctorResult report={state.report} />}
      </div>
    </Section>
  );
}

function DoctorResult({ report }: { report: Report }) {
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
