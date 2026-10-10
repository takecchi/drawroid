import { SkipLink } from '@drawroid/ui';
import { useMatches } from 'react-router';

/** ページが route の handle で名乗る飛び先。「本文へ移動」のすぐ後ろに並ぶ */
export interface SkipLinksHandle {
  skipLinks: { targetId: string; label: string }[];
}

/**
 * いまのページが名乗る飛び先（「発言欄へ移動」など）。名乗らないページでは何も出さない: 行き先の無いページに飛び先を置くと、押しても動かないため
 */
// ページの中ではなく root に並べる: ページの中に置くと、脇の行き先をすべて Tab で通ったあとにしか届かないため
export function PageSkipLinks() {
  const links = useMatches().flatMap(
    (match) => (match.handle as Partial<SkipLinksHandle> | undefined)?.skipLinks ?? [],
  );
  return links.map(({ targetId, label }) => (
    <SkipLink key={targetId} targetId={targetId}>
      {label}
    </SkipLink>
  ));
}
