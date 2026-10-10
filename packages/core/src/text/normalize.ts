const KATAKANA_WITH_HIRAGANA = /[ァ-ヶ]/g;
const HIRAGANA_OFFSET = 0x60;

// 長音・濁点・小書きは寄せない: ビール と ビル、はけ と バケツ、びよういん と びょういん のように、別の語が当たるようになるため
const toHiragana = (text: string) =>
  text.replace(KATAKANA_WITH_HIRAGANA, (kana) =>
    String.fromCharCode(kana.charCodeAt(0) - HIRAGANA_OFFSET),
  );

// NFKC を先にする: 半角カナを全角へ揃えてからでないと、ひらがなへ寄せられないため
export function normalizeForMatch(text: string): string {
  return toHiragana(text.normalize('NFKC')).toLowerCase();
}
