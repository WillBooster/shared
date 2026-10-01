import * as jsYaml from 'js-yaml';
import { isMap, isNode, isScalar, isSeq, Pair, parseDocument } from 'yaml';
import type { Node, YAMLMap, YAMLSeq } from 'yaml';

/**
 * Serializes `value` as the YAML text that replaces `oldContent`. The nodes of `oldContent` that `value` keeps keep
 * their comments and formatting as written (e.g. a bare `workflow_dispatch:`); new and changed values are written as
 * `js-yaml` dumps them, which is also the whole output when `oldContent` is absent or not a parsable mapping.
 */
export function dumpYamlOver(oldContent: string | undefined, value: object): string {
  if (oldContent === undefined) return dumpYaml(value);
  const document = parseDocument(oldContent);
  if (document.errors.length > 0 || !isMap(document.contents)) return dumpYaml(value);

  // updateNode updates a mapping in place when the value is an object.
  updateNode(document.contents, value, oldContent);
  // Folding at a line width would split long values that `js-yaml` writes on one line.
  return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function dumpYaml(value: unknown): string {
  return jsYaml.dump(value, { lineWidth: -1 });
}

function updateNode(node: unknown, value: unknown, source: string): Node {
  if (isMap(node) && isPlainObject(value)) {
    // js-yaml omits undefined properties.
    node.items = Object.entries(value)
      .filter(([, itemValue]) => itemValue !== undefined)
      .map(([key, itemValue]) => {
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key);
        if (!pair) return new Pair(createNode(key), createNode(itemValue));
        moveInlineCommentToKey(pair, source);
        // Only a mapping under a key: `yaml` would print the comment of a sequence entry after its `- ` indicator.
        if (isMap(pair.value)) moveLeadingCommentToFirstItem(pair.value, pair.value.items[0]?.key);
        pair.value = updateNode(pair.value, itemValue, source);
        return pair;
      });
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    const oldItems = node.items;
    moveLeadingCommentToFirstItem(node, isScalar(oldItems[0]) ? oldItems[0] : undefined);
    const unusedItems = new Set(oldItems);
    // A scalar entry is identified by its value and a mapping entry by its position, so that the comments of a removed
    // scalar entry go with it instead of landing on the entry that takes its position.
    node.items = value.map((itemValue, index) => {
      if (isPlainObject(itemValue)) {
        const item = oldItems[index];
        return isMap(item) ? updateNode(item, itemValue, source) : createNode(itemValue);
      }
      const sameScalar = oldItems.find((item) => unusedItems.has(item) && isScalar(item) && item.value === itemValue);
      if (!sameScalar) return createNode(itemValue);
      unusedItems.delete(sameScalar);
      return sameScalar;
    });
    return node;
  }
  if (isScalar(node) && node.value === value) return node;

  const newNode = createNode(value);
  if (isNode(node)) {
    newNode.commentBefore = node.commentBefore;
    newNode.comment = node.comment;
    newNode.spaceBefore = node.spaceBefore;
  }
  return newNode;
}

/**
 * `yaml` attaches a comment that follows a key on its line to the key's mapping or sequence value, together with the
 * comments above the value's first entry.
 */
function moveInlineCommentToKey({ key, value }: Pair, source: string): void {
  if (!isNode(key) || !key.range || !(isMap(value) || isSeq(value)) || !value.commentBefore || !value.range) return;
  if (!/^[ \t]*:[ \t]*#/u.test(source.slice(key.range[1], value.range[0]))) return;

  const [inlineComment, ...commentLines] = value.commentBefore.split('\n');
  key.comment = inlineComment;
  value.commentBefore = commentLines.length > 0 ? commentLines.join('\n') : undefined;
}

/**
 * `yaml` attaches the comment above the first entry of a nested collection to the collection, where it would stay when
 * that entry is removed.
 */
function moveLeadingCommentToFirstItem(node: YAMLMap | YAMLSeq, target: unknown): void {
  if (!node.commentBefore || !isNode(target)) return;
  target.commentBefore = target.commentBefore ? `${node.commentBefore}\n${target.commentBefore}` : node.commentBefore;
  node.commentBefore = undefined;
}

function createNode(value: unknown): Node {
  const contents = parseDocument(dumpYaml(value)).contents;
  if (!isNode(contents)) throw new Error(`js-yaml dumped no YAML node for ${JSON.stringify(value)}.`);
  return contents;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
