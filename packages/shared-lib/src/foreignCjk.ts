export type ForeignCjkLanguage = 'chinese' | 'korean';

const HANGUL_REGEX = /\p{Script=Hangul}/u;
const HAN_REGEX = /\p{Script=Han}/gu;
// Shift_JIS cannot encode these Jōyō kanji, which were added in 2010.
const JOYO_KANJI_OUTSIDE_SHIFT_JIS = '𠮟塡剝頰';
// Shift_JIS can encode these (mostly traditional forms), but Japanese prose practically never uses them outside Chinese.
// Traditional forms common in Japanese words or names (e.g., 儲, 裡, 邊 in 渡邊, 應 in 慶應) are deliberately excluded.
const CHINESE_CHARACTERS_IN_SHIFT_JIS = new Set(
  '个广听从關戲廣聽讀臺這們對會國學樂圖麼與萬沒讓變遞歸兩樣傳價寫寶專將嚴讚觀歡權檢濟藥經驗發點營亂爭亞隨險隱雜雙靈靜顯碼鏈賽醫釋鐵錢輕轉灣數處當來體實'
);

let japaneseKanji: Set<string> | undefined;

/**
 * Detects Chinese or Korean characters mixed into Japanese text, such as LLM-generated Japanese prose.
 * A kanji that Shift_JIS cannot encode is treated as Chinese, so rare kanji such as some in personal names are also reported.
 * Returns the detected languages, or an empty array if none are found.
 */
export function detectForeignCjkInJapanese(text: string): ForeignCjkLanguage[] {
  const normalized = text.normalize('NFKC');
  const languages: ForeignCjkLanguage[] = [];
  japaneseKanji ??= buildJapaneseKanjiSet();
  const kanjiSet = japaneseKanji;
  if (normalized.match(HAN_REGEX)?.some((char) => !kanjiSet.has(char) || CHINESE_CHARACTERS_IN_SHIFT_JIS.has(char))) {
    languages.push('chinese');
  }
  if (HANGUL_REGEX.test(normalized)) languages.push('korean');
  return languages;
}

function buildJapaneseKanjiSet(): Set<string> {
  const decoder = new TextDecoder('shift_jis');
  const kanjiSet = new Set(JOYO_KANJI_OUTSIDE_SHIFT_JIS);
  for (let lead = 0x81; lead <= 0xFC; lead++) {
    for (let trail = 0x40; trail <= 0xFC; trail++) {
      kanjiSet.add(decoder.decode(new Uint8Array([lead, trail])));
    }
  }
  return kanjiSet;
}
