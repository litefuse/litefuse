// @ts-nocheck
// @ts-ignore: no type declarations for '@hyperdx/lucene'
import lucene from "@hyperdx/lucene";
import { decodeSpecialTokens, encodeSpecialTokens } from "./tokenUtils";
import { IMPLICIT_FIELD } from "./constants";
import { EnglishSerializer, Serializer } from "./serializers";

export function parse(query: string): lucene.AST {
  return lucene.parse(encodeSpecialTokens(query));
}

async function nodeTerm(
  node: lucene.Node,
  serializer: Serializer,
): Promise<string> {
  const field = node.field[0] === "-" ? node.field.slice(1) : node.field;
  let isNegatedField = node.field[0] === "-";
  const isImplicitField = node.field === IMPLICIT_FIELD;

  if ((node as lucene.NodeTerm).term != null) {
    const nodeTermInstance = node as lucene.NodeTerm;
    let term = decodeSpecialTokens(nodeTermInstance.term);
    if (isImplicitField && nodeTermInstance.prefix === "-") {
      isNegatedField = true;
    }
    if (!isImplicitField && nodeTermInstance.prefix === "-") {
      term =
        nodeTermInstance.prefix + decodeSpecialTokens(nodeTermInstance.term);
    }

    if (nodeTermInstance.quoted && !isImplicitField) {
      return serializer.eq(field, term, isNegatedField);
    }

    if (!nodeTermInstance.quoted && term === "*") {
      return serializer.isNotNull(field, isNegatedField);
    }

    if (!nodeTermInstance.quoted && term.substring(0, 2) === ">=") {
      if (isNegatedField) {
        return serializer.lt(field, term.slice(2));
      }
      return serializer.gte(field, term.slice(2));
    }
    if (!nodeTermInstance.quoted && term.substring(0, 2) === "<=") {
      if (isNegatedField) {
        return serializer.gt(field, term.slice(2));
      }
      return serializer.lte(field, term.slice(2));
    }
    if (!nodeTermInstance.quoted && term[0] === ">") {
      if (isNegatedField) {
        return serializer.lte(field, term.slice(1));
      }
      return serializer.gt(field, term.slice(1));
    }
    if (!nodeTermInstance.quoted && term[0] === "<") {
      if (isNegatedField) {
        return serializer.gte(field, term.slice(1));
      }
      return serializer.lt(field, term.slice(1));
    }

    let prefixWildcard = false;
    let suffixWildcard = false;
    if (!nodeTermInstance.quoted && term[0] === "*") {
      prefixWildcard = true;
      term = term.slice(1);
    }
    if (!nodeTermInstance.quoted && term[term.length - 1] === "*") {
      suffixWildcard = true;
      term = term.slice(0, -1);
    }

    return serializer.fieldSearch(
      field,
      term,
      isNegatedField,
      prefixWildcard,
      suffixWildcard,
      nodeTermInstance.quoted,
    );
  }

  if ((node as lucene.NodeRangedTerm).inclusive != null) {
    const rangedTerm = node as lucene.NodeRangedTerm;
    return serializer.range(
      field,
      rangedTerm.term_min,
      rangedTerm.term_max,
      isNegatedField,
    );
  }

  throw new Error(`Unexpected Node type. ${node}`);
}

async function serialize(
  ast: lucene.AST | lucene.Node,
  serializer: Serializer,
): Promise<string> {
  if ((ast as lucene.NodeTerm).term != null) {
    return await nodeTerm(ast as lucene.NodeTerm, serializer);
  }
  if ((ast as lucene.NodeRangedTerm).inclusive != null) {
    return await nodeTerm(ast as lucene.NodeTerm, serializer);
  }

  if ((ast as lucene.BinaryAST).right != null) {
    const binaryAST = ast as lucene.BinaryAST;
    const operator = serializer.operator(binaryAST.operator);
    const parenthesized = binaryAST.parenthesized;
    return `${parenthesized ? "(" : ""}${await serialize(binaryAST.left, serializer)} ${operator} ${await serialize(
      binaryAST.right,
      serializer,
    )}${parenthesized ? ")" : ""}`;
  }

  if ((ast as lucene.LeftOnlyAST).left != null) {
    const leftOnlyAST = ast as lucene.LeftOnlyAST;
    const parenthesized = leftOnlyAST.parenthesized;
    return `${parenthesized ? "(" : ""}${
      leftOnlyAST.start !== undefined ? `${leftOnlyAST.start} ` : ""
    }${await serialize(leftOnlyAST.left, serializer)}${parenthesized ? ")" : ""}`;
  }

  return "";
}

export async function genWhereSQL(
  ast: lucene.AST,
  serializer: Serializer,
): Promise<string> {
  return await serialize(ast, serializer);
}

export async function genEnglishExplanation(query: string): Promise<string> {
  try {
    const parsedQ = parse(query);

    if (parsedQ) {
      const serializer = new EnglishSerializer();
      return await serialize(parsedQ, serializer);
    }
  } catch (e) {
    console.warn("Parse failure", query, e);
  }

  return `Message containing ${query}`;
}
