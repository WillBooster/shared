export type ForeignCjkLanguage = 'chinese' | 'korean';

const HANGUL_REGEX = /\p{Script=Hangul}/u;
const HAN_REGEX = /\p{Script=Han}/gu;
// JIS X 0208 cannot encode these Jōyō kanji, which were added in 2010.
const JOYO_KANJI_OUTSIDE_JIS_X_0208 = '𠮟塡剝頰';
// JIS X 0208 can encode these (mostly traditional forms), but Japanese prose practically never uses them outside Chinese.
// Traditional forms common in Japanese words or names (e.g., 儲, 裡, 邊 in 渡邊, 應 in 慶應) are deliberately excluded.
const CHINESE_CHARACTERS_IN_JIS_X_0208 = new Set(
  '个广听从關戲廣聽讀臺這們對會國學樂圖麼與萬沒讓變遞歸兩樣傳價寫寶專將嚴讚觀歡權檢濟藥經驗發點營亂爭亞隨險隱雜雙靈靜顯碼鏈賽醫釋鐵錢輕轉灣數處當來體實'
);

let japaneseKanji: Set<string> | undefined;

/**
 * Detects Chinese or Korean characters mixed into Japanese text, such as LLM-generated Japanese prose.
 * A kanji outside JIS X 0208 is treated as Chinese, except the four Jōyō kanji 𠮟塡剝頰,
 * so rare kanji such as some in personal names (e.g., 髙) are also reported.
 * Returns the detected languages, or an empty array if none are found.
 */
export function detectForeignCjkInJapanese(text: string): ForeignCjkLanguage[] {
  const normalized = text.normalize('NFKC');
  const languages: ForeignCjkLanguage[] = [];
  japaneseKanji ??= buildJapaneseKanjiSet();
  const kanjiSet = japaneseKanji;
  if (normalized.match(HAN_REGEX)?.some((char) => !kanjiSet.has(char) || CHINESE_CHARACTERS_IN_JIS_X_0208.has(char))) {
    languages.push('chinese');
  }
  if (HANGUL_REGEX.test(normalized)) languages.push('korean');
  return languages;
}

function buildJapaneseKanjiSet(): Set<string> {
  // The WHATWG `shift_jis` decoder is Windows-31J, so skip its vendor-extension lead bytes (0xED-0xFC) to keep JIS X 0208 only.
  const decoder = new TextDecoder('shift_jis');
  const kanjiSet = new Set(JOYO_KANJI_OUTSIDE_JIS_X_0208);
  for (let lead = 0x81; lead <= 0xEA; lead++) {
    if (lead >= 0xA0 && lead <= 0xDF) continue;
    for (let trail = 0x40; trail <= 0xFC; trail++) {
      kanjiSet.add(decoder.decode(new Uint8Array([lead, trail])));
    }
  }
  return kanjiSet;
}
