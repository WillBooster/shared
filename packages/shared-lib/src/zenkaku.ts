export function zenkakuAlphanumericalsToHankaku(str: string): string {
  return str.replaceAll(/[０-９Ａ-Ｚａ-ｚ]/g, (s: string) => {
    return String.fromCodePoint((s.codePointAt(0) ?? 0) - 0xfe_e0);
  });
}
