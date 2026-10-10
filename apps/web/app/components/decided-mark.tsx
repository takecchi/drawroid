import { CircleCheck } from 'lucide-react';

/**
 * 人がこの画像に決めた印。走っているジョブで採った画像（adopted）と、止まったジョブでお気に入りにした画像に出す。
 * 画像の枡・大きく見る窓・止まりのカード・ジョブの詳細で同じものを使う
 */
export function DecidedMark({ favorite = false }: { favorite?: boolean }) {
  return (
    <p className="flex items-center gap-1 text-xs font-medium text-ok">
      <CircleCheck aria-hidden className="size-3.5 shrink-0" />
      {favorite ? 'この画像に決めた（お気に入り）' : 'この画像に決めた'}
    </p>
  );
}
