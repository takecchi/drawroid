import {
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { Button as ShadcnButton } from '@/components/ui/button';
import { Card as ShadcnCard } from '@/components/ui/card';
import { Input as ShadcnInput } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea as ShadcnTextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// 見出しの段を呼び手が選べるようにする: 同じ枠がページの直下（h2）にも、操作の中（h3）にも置かれ、段を固定すると見出しの入れ子が崩れるため
type HeadingLevel = 2 | 3 | 4;

export function Section({
  title,
  level = 2,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  level?: HeadingLevel;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const Heading = `h${level}` as const;
  return (
    <ShadcnCard className={cn('gap-3 px-5 py-4', className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title !== undefined && <Heading className="text-base font-semibold">{title}</Heading>}
          {action}
        </div>
      )}
      {children}
    </ShadcnCard>
  );
}

/** 枠の中の小見出し付きのまとまり。枠を重ねずに区切る */
export function SubSection({
  title,
  level = 3,
  className,
  children,
}: {
  title: ReactNode;
  level?: HeadingLevel;
  className?: string;
  children: ReactNode;
}) {
  const Heading = `h${level}` as const;
  return (
    <section
      className={cn('space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0', className)}
    >
      <Heading className="text-sm font-semibold">{title}</Heading>
      {children}
    </section>
  );
}

const BUTTON_VARIANTS = {
  primary: 'default',
  // 既定は縁のある outline にする: 縁の無い secondary は、押せることが形から読めないため
  default: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
} as const;

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return (
    <ShadcnButton
      // type を明示する: 省略すると form の中で submit になり、押した覚えのない送信を作るため
      type="button"
      variant={BUTTON_VARIANTS[variant]}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

const BADGE_TONES = {
  neutral: { variant: 'secondary', className: '' },
  ok: { variant: 'outline', className: 'border-ok/40 bg-ok/10 text-ok' },
  warn: { variant: 'outline', className: 'border-warn/40 bg-warn/10 text-warn' },
  danger: { variant: 'destructive', className: '' },
  muted: { variant: 'outline', className: 'text-muted-foreground' },
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <ShadcnBadge
      variant={BADGE_TONES[tone].variant}
      className={cn(BADGE_TONES[tone].className, className)}
      {...props}
    />
  );
}

/**
 * 文言と入力を1つの label に包む。包む形にするのは、for/id を呼び手に配らせずに、
 * 文言で入力を引けるようにするため。
 */
export function Field({
  label,
  hint,
  wide = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** 行の幅いっぱいに広げる（textarea など） */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('flex flex-col gap-1 text-sm', wide && 'basis-full', className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** 入力のまとまり。legend が名前になる（読み上げは fieldset の名前として読む） */
export function FieldSet({
  legend,
  className,
  children,
}: {
  legend: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={cn('min-w-0 space-y-3 rounded-lg border border-border p-3', className)}>
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * ファイルを選ぶ欄。ブラウザ既定の見た目（英語の「Choose Files」）の代わりに、日本語のボタンと選んだファイル名を出す。
 * ネイティブの input は見えなくするだけで残す: 外側の label（`Field`）で引け、押すとファイルの選択が開くのも、ブラウザに任せるため。
 * `Field` の中に置く（この部品は自分では label を持たない）。
 */
export function FilePicker({
  buttonLabel = 'ファイルを選ぶ',
  selected,
  onChange,
  disabled,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  buttonLabel?: string;
  /** 出すファイル名。省くと、最後に選んだファイルの名前を出す */
  selected?: string[];
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const names = selected ?? picked;
  function change(event: ChangeEvent<HTMLInputElement>) {
    setPicked(Array.from(event.target.files ?? [], (file) => file.name));
    onChange?.(event);
  }
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}>
      <input
        type="file"
        className="peer sr-only"
        disabled={disabled}
        onChange={change}
        {...props}
      />
      {/* 読み上げから外す: 名前は外側の label が持ち、同じ文言を二度読ませないため */}
      <span
        aria-hidden
        className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
      >
        {buttonLabel}
      </span>
      <span className="min-w-0 text-sm break-all text-muted-foreground">
        {names.length === 0 ? '選んでいない' : names.join('、')}
      </span>
    </span>
  );
}

/** チェックボックスと文言を横に並べる。ネイティブの input のまま: 読み手が checked を見る口を変えないため */
export function CheckboxField({
  label,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label className={cn('flex items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="size-4 accent-primary" {...props} />
      {label}
    </label>
  );
}

/** 入力や操作を横に並べ、狭ければ折り返す */
// 上端で揃える: 下端で揃えると、補足（hint）を持つ欄だけ入力の高さがずれるため
export function FieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-wrap items-start gap-3', className)}>{children}</div>;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput className={className} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <ShadcnTextarea className={className} {...props} />;
}

// `size` を受けない: shadcn の `size`（高さの段）と名前が衝突するため
export function Select({
  className,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>) {
  return <NativeSelect className={className} {...props} />;
}

/** 失敗の知らせ。role="alert" を持つ（読み上げに割り込ませるため） */
export function ErrorNote({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Alert variant="destructive" className={cn('border-destructive/40', className)}>
      <AlertDescription className="min-w-0 break-words text-destructive">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** 注意。止めはしないが読んでほしいもの */
export function WarnNote({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm break-words text-warn',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 操作が通ったことの知らせ */
export function OkNote({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('rounded-md bg-ok/10 px-3 py-2 text-sm text-ok', className)}>{children}</p>
  );
}

export function Muted({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>;
}

export function ItemList({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cn('divide-y divide-border', className)}>{children}</ul>;
}

export function Item({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <li className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm', className)}>
      {children}
    </li>
  );
}

/** 箇条書き。Tailwind の土台が list-style を消すので、点を戻す */
export function BulletList({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cn('list-disc space-y-0.5 pl-5 text-sm', className)}>{children}</ul>;
}

/** 名前と値の対の並び。dt と dd（または dt/dd を包む div）を子に渡す */
export function DescriptionList({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground [&>div]:contents',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <pre
      className={cn(
        'max-h-96 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap',
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function Disclosure({
  summary,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDetailsElement>, 'children'> & {
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className={cn('text-sm', className)} {...props}>
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        {summary}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}
