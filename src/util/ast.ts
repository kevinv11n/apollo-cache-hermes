import { // eslint-disable-line import/no-extraneous-dependencies, import/no-unresolved
  ArgumentNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValueNode,
} from 'graphql';

import { JsonScalar } from '../primitive';

/**
 * Extracts the query operation from `document`.
 */
export function getOperationOrDie(document: DocumentNode): OperationDefinitionNode {
  const operations = document.definitions.filter(d => d.kind === 'OperationDefinition') as OperationDefinitionNode[];
  if (!operations.length) {
    throw new Error(`GraphQL document is missing am operation`);
  }
  if (operations.length > 1) {
    throw new Error(`Ambiguous GraphQL document: contains ${operations.length} operations`);
  }

  return operations[0];
}

export interface FragmentMap {
  [Key: string]: FragmentDefinitionNode,
}

/**
 * Extracts fragments from `document` by name.
 */
export function fragmentMapForDocument(document: DocumentNode): FragmentMap {
  const map = {} as FragmentMap;
  for (const definition of document.definitions) {
    if (definition.kind !== 'FragmentDefinition') continue;
    map[definition.name.value] = definition;
  }

  return map;
}

/**
 * A recursive map where the keys indicate the path to any edge in a result set
 * that contain a parameterized edge.
 */
export interface ParameterizedEdgeMap {
  [Key: string]: ParameterizedEdgeMap | ParameterizedEdge;
}

/**
 * Represents the location a variable should be used as an argument to a
 * parameterized edge.
 */
export class VariableArgument {
  constructor(
    /** The name of the variable. */
    public readonly name: string,
  ) {}
}

/**
 * A value that can be expressed as an argument of a parameterized edge.
 */
export type EdgeArgumentScalar = JsonScalar | VariableArgument;
export interface EdgeArgumentArray extends Array<EdgeArgument> {}
export interface EdgeArgumentObject { [Key: string]: EdgeArgument }
export type EdgeArgument = EdgeArgumentScalar | EdgeArgumentArray | EdgeArgumentObject;

/**
 * Represents a parameterized edge (within an edge map).
 */
export class ParameterizedEdge {
  constructor(
    /** The map of arguments and their static or variable values. */
    public readonly args: EdgeArgumentObject,
    /** Any child edge maps. */
    public readonly children?: ParameterizedEdgeMap,
  ) {}
}

/**
 * Walks a selection set, identifying the path to all parameterized edges.
 */
export function parameterizedEdgesForOperation(document: DocumentNode): ParameterizedEdgeMap | undefined {
  // TODO: Memoize.

  const operation = getOperationOrDie(document);
  const fragments = fragmentMapForDocument(document);
  return _buildParameterizedEdgeMap(fragments, operation.selectionSet);
}

/**
 * Recursively builds an edge map.
 *
 * TODO: Support for directives (maybe?).
 */
function _buildParameterizedEdgeMap(fragments: FragmentMap, selectionSet?: SelectionSetNode): ParameterizedEdgeMap | undefined {
  if (!selectionSet) return undefined;

  let edgeMap;

  for (const selection of selectionSet.selections) {
    let key, value;

    // Parameterized edge.
    if (selection.kind === 'Field' && selection.arguments && selection.arguments.length) {
      const args = _buildParameterizedEdgeArgs(selection as any);
      const children = _buildParameterizedEdgeMap(fragments, selection.selectionSet);

      key = selection.name.value;
      value = new ParameterizedEdge(args, children);

    // We need to walk any simple fields that have selection sets of their own.
    } else if (selection.kind === 'Field' && selection.selectionSet) {
      value = _buildParameterizedEdgeMap(fragments, selection.selectionSet);
      if (value) {
        key = selection.name.value;
      }

    // Fragments may include parameterized edges of their own; walk 'em.
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = fragments[selection.name.value];
      if (!fragment) {
        throw new Error(`Expected fragment ${selection.name.value} to exist in GraphQL document`);
      }
      // TODO: Memoize.
      const fragmentEdges = _buildParameterizedEdgeMap(fragments, fragment.selectionSet);
      if (fragmentEdges) {
        edgeMap = { ...edgeMap, ...fragmentEdges };
      }
    }

    // TODO: inline fragments.

    if (key) {
      edgeMap = edgeMap || {};
      edgeMap[key] = value;
    }
  }

  return edgeMap;
}

/**
 * Build the map of arguments to their natural JS values (or variables).
 */
function _buildParameterizedEdgeArgs(field: FieldNode & { arguments: ArgumentNode[] }) {
  const args = {};
  for (const arg of field.arguments) {
    args[arg.name.value] = _valueFromNode(arg.value);
  }

  return args;
}

/**
 * Evaluate a ValueNode and yield its value in its natural JS form.
 */
function _valueFromNode(node: ValueNode): any {
  if (node.kind === 'Variable') {
    return new VariableArgument(node.name.value);
  } else if (node.kind === 'NullValue') {
    return null;
  } else if (node.kind === 'IntValue') {
    return parseInt(node.value);
  } else if (node.kind === 'FloatValue') {
    return parseFloat(node.value);
  } else if (node.kind === 'ListValue') {
    return node.values.map(_valueFromNode);
  } else if (node.kind === 'ObjectValue') {
    const value = {};
    for (const field of node.fields) {
      value[field.name.value] = _valueFromNode(field.value);
    }
    return value;
  } else {
    return node.value;
  }
}

/**
 * Sub values in for any variables required by an edge's args.
 */
export function expandEdgeArguments(edge: ParameterizedEdge, variables: object = {}): object {
  const edgeArguments = {} as any;
  // TODO: Recurse into objects/arrays.
  for (const key in edge.args) {
    let arg = edge.args[key];
    if (arg instanceof VariableArgument) {
      if (!(arg.name in variables)) {
        // TODO: Detect optional variables?
        throw new Error(`Expected variable $${arg.name} to exist for query`);
      }
      arg = variables[arg.name];
    }

    edgeArguments[key] = arg;
  }

  return edgeArguments;
}