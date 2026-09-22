export type ForeignCjkLanguage = 'chinese' | 'korean';

const HANGUL_REGEX = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
// Simplified or traditional characters that Japanese text practically never uses.
// Never add a character that appears in ordinary Japanese (e.g., 数, 据, 写, 算).
const CHINESE_SPECIFIC_CHARACTER_REGEX =
  /[个们吗图乐习汉语开关击敌胜败级测设边过这难戏时获广龙队间听说读练车门电变类对输执结码为组应该还从实现义页确请错误调试运递归链节两样么库环计關擊戲廣聽說讀臺]/u;

/**
 * Detects Chinese or Korean characters mixed into Japanese text, such as LLM-generated Japanese prose.
 * Returns the detected languages, or an empty array if none are found.
 */
export function detectForeignCjkInJapanese(text: string): ForeignCjkLanguage[] {
  const normalized = text.normalize('NFKC');
  const languages: ForeignCjkLanguage[] = [];
  if (CHINESE_SPECIFIC_CHARACTER_REGEX.test(normalized)) languages.push('chinese');
  if (HANGUL_REGEX.test(normalized)) languages.push('korean');
  return languages;
}
