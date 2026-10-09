import { cn } from '@/lib/utils';

// 名前を大文字にしない: 製品名の綴りが小文字のため
// 印は「画布と、そこに置いた1つの色」: alteroid の印（重なる2つの輪）の線の太さと色の使い方にそろえ、形だけを drawroid のものにした
export function BrandMark({
  withWordmark = true,
  className,
}: {
  withWordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <svg
        viewBox="0 0 24 24"
        className="size-5 shrink-0"
        aria-hidden
        focusable="false"
        fill="none"
      >
        <rect
          x="3"
          y="4"
          width="18"
          height="16"
          rx="3"
          className="stroke-foreground"
          strokeWidth="1.5"
        />
        <circle cx="15.5" cy="9.5" r="2.5" className="fill-primary" />
        <path
          d="M3.75 17 L9 11.5 L13.5 16"
          className="stroke-primary"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {withWordmark && (
        <span className="font-display text-[13px] leading-none tracking-[0.08em]">drawroid</span>
      )}
    </span>
  );
}
