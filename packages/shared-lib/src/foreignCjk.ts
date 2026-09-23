export type ForeignCjkLanguage = 'chinese' | 'korean';

const HANGUL_REGEX = /\p{Script=Hangul}/u;
const HAN_REGEX = /\p{Script=Han}/u;
// JIS X 0208 cannot encode these Jōyō kanji, which were added in 2010.
const JOYO_KANJI_OUTSIDE_JIS_X_0208 = '𠮟塡剝頰';
// Kanji for Japanese names (e.g., 髙, 﨑, 濵, 栁) that Chinese prose rarely contains: the NFKC forms of the
// Windows-31J NEC-selected IBM and IBM extension kanji that neither JIS X 0208, Big5, nor GB2312 encodes, plus 𠮷 from
// JIS X 0213. NFKC forms are listed because the lookup runs after NFKC normalization (e.g., 蘒 U+FA20 becomes U+8612).
// Some also appear in Chinese names (e.g., 喆), but prose that mixes Chinese into Japanese hardly contains them.
// Extension kanji that Big5 or GB2312 encodes (e.g., 德, 瀨) stay Chinese because Chinese prose uses them.
const JAPANESE_NAME_KANJI_OUTSIDE_JIS_X_0208 =
  '仼伃伹侊俿偂僘僴兊兤冝凬刕劜劯匇匤厓叝咊咜喆坙坥垬埈墲夋奛奝奣尞岺峵嵓嵭嶹巐弡弴彅惞愑愰憘戓抦敎昞昻晳暿曺曻朎杦栁桒棏樰橳櫢櫤涖淸澵濵焏犱犾猤玽甁硺礰竧箞絈緖罇荢葈蓜蘒蠇裵褜訷贒郞鄕釞釥鈼鉙鉷鍈鏆隝隯霳霻靍靏靑靕髙魲鮏鮱鮻鰀﨎﨏﨑﨓﨔﨟﨡﨣﨤﨧﨨﨩𠮷';
// Characters JIS X 0208 can encode but modern Japanese prose does not use:
// - old forms (kyūjitai) of Jōyō kanji, from the `kyujitai` npm package and Unihan's kJapaneseOldVariant,
//   except those still common in Japanese words or names (e.g., 應 in 慶應, 澤, 邊, 龍, 藝 in 東京藝術大学, 糺す)
// - Chinese function words that Japanese writes in kana (e.g., 們, 這, 麼, 很, 怎, 跟, 嘛) and stray simplified forms (e.g., 个)
// - traditional Chinese characters that neither table covers but Japanese never uses: 碼, 舉, 鏈, 雖
// Other Chinese-only content characters (e.g., 媽, 豬) are not listed because separating them from rare kanji
// that Japanese prose does use (e.g., 乖離, 瑕疵, 齟齬, 俯瞰) needs Japanese usage frequencies.
const CHINESE_CHARACTERS_IN_JIS_X_0208 = new Set(
  '个乘亂亞从佛來們假傳僞價儉兒兩册刄剩劍劑勞勳勵勸區卷參听呀咯哇哦唔單嘛嚴囑囘圈國圍圓圖團墮壓壘壞壤壯壹壻壽奧奬姙孃學寢實寫寶將專對屆屬峽巖帶广廢廣廳彈很徑從怎恆惡惱愼慘懷戀戰戲拂拔拜挾插搖搜擇擔據擧擴攜攝收效敍敕數斷晝曉會條棧榮樂樓樞樣檢權歐歡歸殘殼毆氣沒淨淺滯滿潛澁濕濟灣燈燒營爐爭爲犧狹獨獵獸獻瓣畫當疊癡發盜盡碎碼祕禪禮稱稻穗穩竊竝粹絲經縣縱總繩繪繼續纖缺罐聲聽肅腦膽臟臺與舉舊舍舖艷莊莖萬藏藥處號螢蟲蠶蠻衞裝襃覺覽觀觸謠證譯譽讀變讓讚豐豫貳賣贊跟踐輕轉辨辭辯這遙遞遲鄰醉醫釀釋錢鎭鏈鐵鑄鑛關陷隨險隱隸雖雙雜霸靈靜顏顯飜飮餘餠騷驅驗驛髓體髮鬪鷄鹽麥麼黏默點黨齊齒齡龜'
);

let japaneseKanji: Set<string> | undefined;

/**
 * Detects Chinese or Korean characters mixed into Japanese text, such as LLM-generated Japanese prose.
 * See {@link findForeignCjkCharactersInJapanese} for which characters count and how `allowedText` works.
 * Returns the detected languages, or an empty array if none are found.
 */
export function detectForeignCjkInJapanese(text: string, allowedText?: string): ForeignCjkLanguage[] {
  const characters = findForeignCjkCharactersInJapanese(text, allowedText);
  const languages: ForeignCjkLanguage[] = [];
  if (characters.some((char) => !HANGUL_REGEX.test(char))) languages.push('chinese');
  if (characters.some((char) => HANGUL_REGEX.test(char))) languages.push('korean');
  return languages;
}

/**
 * Returns the distinct Chinese or Korean characters mixed into Japanese text, NFKC-normalized, in order of appearance.
 * A kanji is treated as Chinese when it is outside JIS X 0208 (except the four Jōyō kanji 𠮟塡剝頰 and Japanese name
 * kanji that neither Big5 nor GB2312 encodes, e.g., 髙, 﨑, 𠮷) or is one of the listed old forms, Chinese function
 * words, or other Chinese-only characters that modern Japanese prose does not use (e.g., 對, 國, 這, 們, 很, 碼).
 * Old forms in names that Chinese prose also uses (e.g., 國, 與, 德) are therefore also reported, while Chinese
 * containing none of these characters (e.g., 最后返回答案, 豬肉) is not.
 * Characters that also occur in `allowedText` are not reported, so passing the input that an LLM may quote
 * (e.g., the prompt, a question, or an error message) keeps quoted names and code from being reported.
 */
export function findForeignCjkCharactersInJapanese(text: string, allowedText = ''): string[] {
  const allowedCharacters = new Set(allowedText.normalize('NFKC'));
  const kanjiSet = (japaneseKanji ??= buildJapaneseKanjiSet());
  const characters = new Set<string>();
  for (const char of text.normalize('NFKC')) {
    if (allowedCharacters.has(char)) continue;
    if (
      HANGUL_REGEX.test(char) ||
      (HAN_REGEX.test(char) && (!kanjiSet.has(char) || CHINESE_CHARACTERS_IN_JIS_X_0208.has(char)))
    ) {
      characters.add(char);
    }
  }
  return [...characters];
}

function buildJapaneseKanjiSet(): Set<string> {
  // The WHATWG `shift_jis` decoder is Windows-31J, so skip its vendor-extension lead bytes (0xED-0xFC) to keep JIS X 0208 only.
  const decoder = new TextDecoder('shift_jis');
  const kanjiSet = new Set([...JOYO_KANJI_OUTSIDE_JIS_X_0208, ...JAPANESE_NAME_KANJI_OUTSIDE_JIS_X_0208]);
  for (let lead = 0x81; lead <= 0xEA; lead++) {
    if (lead >= 0xA0 && lead <= 0xDF) continue;
    for (let trail = 0x40; trail <= 0xFC; trail++) {
      kanjiSet.add(decoder.decode(new Uint8Array([lead, trail])));
    }
  }
  return kanjiSet;
}
