import { expect, test } from 'bun:test';

import { detectForeignCjkInJapanese } from '../../src/foreignCjk.js';

test('detectForeignCjkInJapanese accepts Japanese prose including rare kanji and names', () => {
  expect(
    detectForeignCjkInJapanese(
      'この関数は配列を再帰的に処理し、結果を返します。曖昧な閾値、冪等性、乖離、瑕疵、齟齬を𠮟る。慶應の中澤さん。'
    )
  ).toEqual([]);
});

test('detectForeignCjkInJapanese reports simplified and traditional Chinese', () => {
  expect(detectForeignCjkInJapanese('この関数は数组を处理します。')).toEqual(['chinese']);
  expect(detectForeignCjkInJapanese('這是你的東西嗎？')).toEqual(['chinese']);
  expect(detectForeignCjkInJapanese('我很好')).toEqual(['chinese']);
});

test('detectForeignCjkInJapanese treats Windows-31J extension kanji as outside Japanese', () => {
  expect(detectForeignCjkInJapanese('道德')).toEqual(['chinese']);
});

test('detectForeignCjkInJapanese reports Hangul including half-width and extended jamo', () => {
  expect(detectForeignCjkInJapanese('この関数は 배열 を返します。')).toEqual(['korean']);
  expect(detectForeignCjkInJapanese('ﾡꥠ')).toEqual(['korean']);
  expect(detectForeignCjkInJapanese('这个 배열')).toEqual(['chinese', 'korean']);
});
