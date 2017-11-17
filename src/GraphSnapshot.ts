
import lodashGet = require('lodash.get');

import { NodeSnapshot, ParameterizedValueSnapshot } from './nodes';
import { QueryResult, QueryResultWithNodeIds } from './operations/read';
import { PathPart } from './primitive';
import { Queryable } from './Queryable';
import { NodeId, OperationInstance } from './schema';
import { pathBeginsWith } from './util';

export type NodeSnapshotMap = { [Key in NodeId]: NodeSnapshot; };
/**
 * Maintains an identity map of all value snapshots that reference into a
 * particular version of the graph.
 *
 * Provides an immutable view into the graph at a point in time.
 *
 * Also provides a place to hang per-snapshot caches off of.
 */
export class GraphSnapshot {

  /** Cached results for queries. */
  public readonly readCache = new Map<OperationInstance, QueryResult | QueryResultWithNodeIds>();

  /**
   * @internal
   */
  constructor(
    // TODO: Profile Object.create(null) vs Map.
    public _values: NodeSnapshotMap = Object.create(null),
  ) {}

  /**
   * Retrieves the value identified by `id`.
   */
  getNodeData(id: NodeId): Readonly<any> | undefined {
    const snapshot = this.getNodeSnapshot(id);
    return snapshot ? snapshot.data : undefined;
  }

  /**
   * Returns whether `id` exists as an value in the graph.
   */
  has(id: NodeId): boolean {
    return id in this._values;
  }

  /**
   * Retrieves the snapshot for the value identified by `id`.
   *
   * @internal
   */
  getNodeSnapshot(id: NodeId): Readonly<NodeSnapshot> | undefined {
    return this._values[id];
  }

  /**
   * Returns the set of ids present in the snapshot.
   *
   * @internal
   */
  allNodeIds(): NodeId[] {
    return Object.keys(this._values);
  }

  forEachFieldInstance(nodeId: NodeId, path: PathPart[], iterator: Queryable.FieldInstanceIterator): void {
    const node = this.getNodeSnapshot(nodeId);
    if (!node) return;

    // Trigger the iterator if there is a static version of the field.
    const staticValue = lodashGet(node.data, path);
    if (staticValue !== undefined) {
      iterator(staticValue);
    }

    if (!node.outbound) return;
    for (const reference of node.outbound) {
      if (!pathBeginsWith(reference.path, path)) continue;
      const referencedNode = this.getNodeSnapshot(reference.id);
      // Any other kind of reference is already covered by the static iterator
      // triggered above.
      if (!(referencedNode instanceof ParameterizedValueSnapshot)) continue;

      iterator(referencedNode.data, referencedNode.args);
    }
  }

}
