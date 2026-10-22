import type * as ast from 'typescript/unstable/ast';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits that all refer to positions in the original text. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

export function findProperty(
  objectLiteral: ast.ObjectLiteralExpression,
  key: string,
  source: ast.SourceFile
): ast.ObjectLiteralElementLike | undefined {
  return objectLiteral.properties.find(
    (property) => 'name' in property && property.name && getPropertyKey(property.name, source) === key
  );
}

/**
 * Appends `key: value` texts to the object literal. `removedProperty` must be the property that
 * {@link removePropertyEdit} deletes in the same edit set, if any, so the comma before the
 * insertion is computed from the remaining properties.
 */
export function insertPropertiesEdit(
  source: ast.SourceFile,
  objectLiteral: ast.ObjectLiteralExpression,
  propertyTexts: readonly string[],
  removedProperty?: ast.ObjectLiteralElementLike
): TextEdit {
  const insertionPoint = objectLiteral.getEnd() - 1;
  const lastProperty = objectLiteral.properties.findLast((property) => property !== removedProperty);
  // The native TS AST does not reliably expose `properties.hasTrailingComma`, so scan the source
  // between the last property and the closing brace. Strip comments first so a comma inside a
  // trailing comment (e.g. `foo: 1 // a, b`) is not mistaken for a real trailing comma.
  const hasTrailingComma = lastProperty
    ? stripComments(source.text.slice(lastProperty.getEnd(), insertionPoint)).includes(',')
    : true;
  return {
    start: insertionPoint,
    end: insertionPoint,
    text: `${hasTrailingComma ? '' : ', '}${propertyTexts.join(', ')}`,
  };
}

/**
 * Deletes the property with its leading trivia and the comma right after it. Removing the last
 * property thus leaves a trailing comma behind the remaining ones, which the formatter drops.
 */
export function removePropertyEdit(source: ast.SourceFile, property: ast.ObjectLiteralElementLike): TextEdit {
  const following = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*,/u.exec(source.text.slice(property.getEnd()));
  return { start: property.getFullStart(), end: property.getEnd() + (following?.[0].length ?? 0), text: '' };
}

// Return a property key without surrounding quotes, so `'reactCompiler'` matches `reactCompiler`.
// Identifier, string-literal and numeric-literal names all expose the unquoted value via `.text`.
function getPropertyKey(name: ast.PropertyName, source: ast.SourceFile): string {
  return 'text' in name && typeof name.text === 'string' ? name.text : name.getText(source);
}

function stripComments(text: string): string {
  return text.replaceAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
}
