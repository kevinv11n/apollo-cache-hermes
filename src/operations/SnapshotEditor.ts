import { // eslint-disable-line import/no-extraneous-dependencies, import/no-unresolved
  SelectionSetNode,
} from 'graphql';

import { CacheContext } from '../context';
import { DynamicField, DynamicFieldWithArgs, DynamicFieldMap, isDynamicFieldWithArgs } from '../DynamicField';
import { GraphSnapshot } from '../GraphSnapshot';
import { EntitySnapshot, NodeSnapshot, ParameterizedValueSnapshot, cloneNodeSnapshot } from '../nodes';
import { JsonObject, JsonValue, PathPart } from '../primitive';
import { NodeId, ParsedQuery, Query } from '../schema';
import {
  FragmentMap,
  addNodeReference,
  addToSet,
  hasNodeReference,
  isObject,
  isScalar,
  lazyImmutableDeepSet,
  removeNodeReference,
  get,
} from '../util';

/**
 * A newly modified snapshot.
 */
export interface EditedSnapshot {
  snapshot: GraphSnapshot;
  editedNodeIds: Set<NodeId>;
  writtenQueries: Set<ParsedQuery>;
}

/**
 * Describes an edit to a reference contained within a node.
 */
interface ReferenceEdit {
  /** The node that contains the reference. */
  containerId: NodeId;
  /** The path to the reference within the container. */
  path: PathPart[];
  /** The id of the node that was previously referenced. */
  prevNodeId: NodeId | undefined;
  /** The id of the node that should be referenced. */
  nextNodeId: NodeId | undefined;
}

/**
 * Builds a set of changes to apply on top of an existing `GraphSnapshot`.
 *
 * Performs the minimal set of edits to generate new immutable versions of each
 * node, while preserving immutability of the parent snapshot.
 */
export class SnapshotEditor {

  /**
   * Tracks all node snapshots that have changed vs the parent snapshot.
   */
  private _newNodes: { [Key in NodeId]: NodeSnapshot | undefined } = Object.create(null);

  /**
   * Tracks the nodes that have new _values_ vs the parent snapshot.
   *
   * This is a subset of the keys in `_newValues`.  The difference is all nodes
   * that have only changed references.
   */
  private _editedNodeIds = new Set<NodeId>();

  /**
   * Tracks the nodes that have been rebuilt, and have had all their inbound
   * references updated to point to the new value.
   */
  private _rebuiltNodeIds = new Set<NodeId>();

  /** The queries that were written, and should now be considered complete. */
  private _writtenQueries = new Set<ParsedQuery>();

  constructor(
    /** The configuration/context to use when editing snapshots. */
    private _context: CacheContext,
    /** The snapshot to base edits off of. */
    private _parent: GraphSnapshot,
  ) {}

  /**
   * Merge a GraphQL payload (query/fragment/etc) into the snapshot, rooted at
   * the node identified by `rootId`.
   */
  mergePayload(query: Query, payload: JsonObject): void {
    const parsed = this._context.parseQuery(query);

    // First, we walk the payload and apply all _scalar_ edits, while collecting
    // all references that have changed.  Reference changes are applied later,
    // once all new nodes have been built (and we can guarantee that we're
    // referencing the correct version).
    const { referenceEdits } = this._mergePayloadValuesUsingSelectionSetAsGuide(parsed, payload);

    // Now that we have new versions of every edited node, we can point all the
    // edited references to the correct nodes.
    //
    // In addition, this performs bookkeeping the inboundReferences of affected
    // nodes, and collects all newly orphaned nodes.
    const orphanedNodeIds = this._mergeReferenceEdits(referenceEdits);

    // At this point, every node that has had any of its properties change now
    // exists in _newNodes.  In order to preserve immutability, we need to walk
    // all nodes that transitively reference an edited node, and update their
    // references to point to the new version.
    this._rebuildInboundReferences();

    // Remove (garbage collect) orphaned subgraphs.
    this._removeOrphanedNodes(orphanedNodeIds);

    // The query should now be considered complete for future reads.
    this._writtenQueries.add(parsed);
  }

  private _mergePayloadValuesUsingSelectionSetAsGuide(query: ParsedQuery, fullPayload: JsonObject) {
    const referenceEdits: ReferenceEdit[] = [];
    this._walkSelectionSets(
      query.info.operation.selectionSet,
      fullPayload,
      /* prevPath */ [],
      query.dynamicFieldMap,
      query.rootId,
      query.info.fragmentMap,
      referenceEdits
    );
    return { referenceEdits };
  }

  /**
   * A helper function that will walk query selection sets recursively and write
   * values into the graph snapshot.
   *
   * TODO(yuisu): consider nest this function into
   * _mergePayloadValuesUsingSelectionSetAsGuide
   */
  private _walkSelectionSets(
    // a current graphql selection node we are visiting
    currentGraphqlNode: SelectionSetNode,
    // a JSON payload with the shape matching current graphql node
    prevPayload: JsonValue,
    // a array of PathPart that lead to current graphql selection
    prevPath: PathPart[],
    prevDynamicFieldMap: DynamicFieldMap | undefined,
    originalContainerId: string,
    fragmentsMap: FragmentMap,
    referenceEdits: ReferenceEdit[]): void {
    if (prevPayload === undefined) {
      return;
    }

    for (const selection of currentGraphqlNode.selections) {
      let currentContainerId = originalContainerId;
      switch (selection.kind) {
        case 'Field': {
          /**
           * if there is no sub-selectionSet, threat the value as leaf and just
           * point to the payload value. if there exist a child, walk the
           * sub-selectionSet
           */

          // TODO(yuisu): should we be worry about both alias and real field
          // name have payload value?
          const cacheKey = selection.name.value;
          const payloadKey = selection.alias ? selection.alias.value : cacheKey;
          let currentPayload = prevPayload === null ? prevPayload : prevPayload[payloadKey];
          const currentDynamicFieldMap = get(prevDynamicFieldMap, payloadKey);

          // For non-parameterized field, we simply append current cacheKey to
          // create a new path to the field.
          //
          //   user: {
          //     name: 'Bob',   -> newPath: ['user', 'name']
          //     address: {     -> newPath: ['user', 'address']
          //       city: 'A',   -> newPath: ['user', 'address', 'city']
          //       state: 'AB', -> newPath: ['user', 'address', 'state']
          //     },
          //     info: {
          //       id: 0,       -> newPath: ['id']
          //       prop1: 'hi'  -> newPath: ['prop1']
          //     },
          //     prevAddress: [
          //       {
          //         postal: 123 -> newPath: ['user', 'prevAddress', 0, postal]
          //       },
          //       {
          //         postal: 456 -> newPath: ['user', 'prevAddress', 1, postal]
          //       }
          //     ],
          //     phone: [
          //       '1234', -> newPath: ['user', 0]
          //       '5678', -> newPath: ['user', 1]
          //     ],
          //   },
          //

          // A parameterized graph node, the node-value under the
          // parameterized key will be a direct reference to a
          // node value of the corresponding entity GraphNodeSnapshot.
          // e.g.
          //   'ROOT_QUERY❖["foo"]❖{"id":1,"withExtra":true}'
          //     (node value is a direct reference to node value at key '1')
          //   1: { id: 1, ...}
          // This is because parameterized key can only have one value so
          // there is no need to store another indirection like
          // non-parameterized node
          //
          // A non-parameterized graph node, the node-value under the
          // RootQueryId will be an object in which each key is the
          // selection name with the value be either
          //   - a direct reference to a node value of corresponding
          //     entity GraphNodeSnapshot
          //   - an object (in the case of non-entity).
          // e.g.
          //   'ROOT_QUERY'
          //     node : {
          //      1: <reference to node value of entity "1">
          //      2: { ...<some prop of the non-entity> }
          //   1: { id: 1, ...}
          //
          // Thus, when the prevPath is undefined indicating that
          // we just reenter the function with parameterized
          // containerId, we can look directly for previousNodeValue.
          // For non-parameterized, we will have to do redirection.
          let previousNodeValue: JsonValue | undefined;
          let currentPath: PathPart[];
          // If it is parameterized edge, we will want to reprocess it first
          // so that we can set container ID to be parameterized container ID.
          const isParameterizedField = isDynamicFieldWithArgs(currentDynamicFieldMap);
          if (isParameterizedField) {
            currentContainerId = this._ensureParameterizedValueSnapshot(
              currentContainerId,
              [...prevPath, cacheKey],
              currentDynamicFieldMap
            );
            // We reset the path to current field because parameterized
            // field is its own entity node in the graph.
            //
            // If the current parameterized field is a leaf, we will store
            // the value directly on the node because the parameterized key
            // is unique to a particular value.  E.g.
            //
            //   message(count: $count) -> newPath = []
            //     detailMessage(count: $count) {
            //       title -> newPath = [title]
            //     }
            //   }
            //
            currentPath = [];
            const containerSnapshot = this.getNodeSnapshot(currentContainerId);
            const containerNode = containerSnapshot ? containerSnapshot.node : undefined;
            previousNodeValue = containerNode;
          } else {
          // If this is the prevPayload is a top element in the array and is
          // null, just write out 'null' as an element instead of wrapping it in
          // the object.  E.g.
          //
          //   articles: [
          //     null, -> selection will be 'title' when visiting this element
          //     {
          //       title: 10,
          //       body: 'hello',
          //     },
          //   ],
          //
          // Snapshot values should be : [null, { title: 10, body: 'hello' }]
            if (typeof prevPath[prevPath.length - 1] === 'number' && prevPayload === null) {
              currentPath = [...prevPath];
            } else {
              currentPath = [...prevPath, cacheKey];
            }
            const containerSnapshot = this.getNodeSnapshot(currentContainerId);
            const containerNode = containerSnapshot ? containerSnapshot.node : undefined;
            previousNodeValue = containerNode && containerNode[cacheKey];
          }

          // Only trying to get previousNodeId if the current select is expect
          // to be an object and possible should be treat as entity.  E.g.
          //
          //  query: { foo }
          //  previous: { foo: { id: 0, name: 'Foo' } }
          //  current: null
          //
          // We don't want to treat previousValue as an entity for at above case
          // and get its Id.
          const previousNodeId = isObject(previousNodeValue) && selection.selectionSet
            ? this._context.entityIdForNode(previousNodeValue) : undefined;

          if (previousNodeValue !== undefined && previousNodeValue === currentPayload) break;

          // Check for missing payload value.
          // Explicitly check for "undefined" as we should
          // persist other falsy value (see: "writeFalsyValues" test).
          if (currentPayload === undefined) {
          // The currentPayload doesn't have the value.
          // Look into containerNode (which can be previous snapshot)
          // for possible reuse value. We explicitly check for undefined
          // as it indicates that the value doesn't exist.
            currentPayload = previousNodeValue !== undefined
              ? previousNodeValue : null;
          }

          // This field is a leaf field and does not contain any nested
          // selection sets just reference payload value in the graph snapshot
          // node.
          if (currentPayload === null || !selection.selectionSet) {
          // Fix references. See: orphan node tests on "orphan a subgraph"
          // The new value is null and the old value is an entity. We will
          // want to remove reference to such entity
            if (previousNodeId) {
              referenceEdits.push({
                containerId: currentContainerId,
                path: currentPath,
                prevNodeId: previousNodeId,
                nextNodeId: undefined,
              });
            }
            // We intentionally do not deep copy the nodeValue as Apollo will
            // then perform Object.freeze anyway. So any change in the payload
            // value afterward will be reflect in the graph as well.
            //
            // We use selection.name.value instead of payloadKey so that we
            // always write to cache using real field name rather than alias
            // name.
            this._setValue(currentContainerId, currentPath, currentPayload);
          } else if (selection.selectionSet) {
          // This field contains nested selectionSet so recursively walking the
          // sub-selectionSets. We expect to have an object or an array as a
          // payload value. If not, the payload cannot have matching shape as
          // the sub-selectionSets. Check if payload is a object or array, throw
          // an error if it isn't.

            if (isScalar(currentPayload)) {
            // TODO(yuisu): sentry? should we continue and just write null ?
              throw new Error(`Hermes Error: At field-"${payloadKey}",
  expected an object or array as a payload but get "${JSON.stringify(currentPayload)}"`);
            }

            // It is still possible to be a DynamicField in the case of alias
            const childDynamicMap = currentDynamicFieldMap instanceof DynamicField
              ? currentDynamicFieldMap.children : currentDynamicFieldMap;

            if (Array.isArray(currentPayload)) {
              // TODO(yuisu): check consistency of the array.  E.g all elements
              // are entities, or none are.
              const payloadLength = currentPayload.length;
              const previousLength = Array.isArray(previousNodeValue)
                ? previousNodeValue.length : -1;

              let newArray: Array<JsonValue> | undefined;
              if (payloadLength !== previousLength) {
                newArray = Array.isArray(previousNodeValue)
                  ? previousNodeValue.slice(0, previousLength) : new Array(payloadLength);

                this._setValue(currentContainerId, currentPath, newArray);
              }

              for (let idx = 0; idx < payloadLength; ++idx) {
                const element = currentPayload[idx];
                const nextNodeId = this._context.entityIdForNode(element);
                const previousNodeAtIdx = get(previousNodeValue, idx);
                const previousChildNodeId = isObject(previousNodeAtIdx)
                  ? this._context.entityIdForNode(previousNodeAtIdx) : undefined;

                const elementPath = [...currentPath];
                elementPath.push(idx);

                // If an element in an array is 'undefined' (sparse array) or
                // 'null' (holes), we want to simply write out null in the
                // newArray otherwise recurse so we patch up an existed array.
                //
                // For example see: "treats blanks in sparse arrays as null" and
                // "returns the selected values, overlaid on the underlying
                // data"
                if (!element && newArray) {
                  newArray[idx] = null;
                } else if (nextNodeId) {
                  this._walkSelectionSets(
                    selection.selectionSet,
                    element,
                    [],
                    childDynamicMap,
                    nextNodeId,
                    fragmentsMap,
                    referenceEdits
                  );
                } else {
                  this._walkSelectionSets(
                    selection.selectionSet,
                    element,
                    elementPath,
                    childDynamicMap,
                    currentContainerId,
                    fragmentsMap,
                    referenceEdits
                  );
                }

                // The reference between old and new one change, so update the
                // reference
                if (previousChildNodeId !== nextNodeId) {
                  referenceEdits.push({
                    containerId: currentContainerId,
                    path: elementPath,
                    prevNodeId: previousChildNodeId,
                    nextNodeId,
                  });
                }
              }
              break;
            }

            const entityIdOfCurrentPayload = this._context.entityIdForNode(currentPayload);
            let nextNodeId = entityIdOfCurrentPayload;

            if (nextNodeId || previousNodeId) {
            // TODO(yuisu): error when there is an inconsistent of being entity
            // between new node and previous node
              if (!nextNodeId && prevPayload) {
                nextNodeId = previousNodeId;
              }

              if (previousNodeId !== nextNodeId) {
                referenceEdits.push({
                  containerId: currentContainerId,
                  path: currentPath,
                  prevNodeId: previousNodeId,
                  nextNodeId,
                });
              }
            }

            // CurrentPayload is considered as an entity.
            if (entityIdOfCurrentPayload !== undefined) {
              this._walkSelectionSets(
                selection.selectionSet,
                currentPayload,
                /* prevPath */[],
                childDynamicMap,
                  nextNodeId!,
                  fragmentsMap,
                  referenceEdits
              );
            } else {
            // CurrentPayload is not an entity so we didn't reset the path
              this._walkSelectionSets(
                selection.selectionSet,
                currentPayload,
                currentPath,
                childDynamicMap,
                currentContainerId,
                fragmentsMap,
                referenceEdits
              );
            }
          }
          break;
        }
        case 'FragmentSpread': {
          const fragmentNode = fragmentsMap[selection.name.value];
          this._walkSelectionSets(
            fragmentNode.selectionSet,
            prevPayload,
            prevPath,
            prevDynamicFieldMap,
            currentContainerId,
            fragmentsMap,
            referenceEdits
          );
          break;
        }
        case 'InlineFragment': {
          this._context.warn(`Hermes Error: InlineFragment is not yet support`);
          break;
        }
      }
    }
  }

  /**
   * Update all nodes with edited references, and ensure that the bookkeeping of
   * the new and _past_ references are properly updated.
   *
   * Returns the set of node ids that are newly orphaned by these edits.
   */
  private _mergeReferenceEdits(referenceEdits: ReferenceEdit[]) {
    const orphanedNodeIds: Set<NodeId> = new Set();

    for (const { containerId, path, prevNodeId, nextNodeId } of referenceEdits) {
      const target = nextNodeId ? this.getDataNodeOfNodeSnapshot(nextNodeId) : null;
      this._setValue(containerId, path, target);
      const container = this._ensureNewSnapshot(containerId);

      if (prevNodeId) {
        removeNodeReference('outbound', container, prevNodeId, path);
        const prevTarget = this._ensureNewSnapshot(prevNodeId);
        removeNodeReference('inbound', prevTarget, containerId, path);
        if (!prevTarget.inbound) {
          orphanedNodeIds.add(prevNodeId);
        }
      }

      if (nextNodeId) {
        addNodeReference('outbound', container, nextNodeId, path);
        const nextTarget = this._ensureNewSnapshot(nextNodeId);
        addNodeReference('inbound', nextTarget, containerId, path);
        orphanedNodeIds.delete(nextNodeId);
      }
    }

    return orphanedNodeIds;
  }

  /**
   * Transitively walks the inbound references of all edited nodes, rewriting
   * those references to point to the newly edited versions.
   */
  private _rebuildInboundReferences() {
    const queue = Array.from(this._editedNodeIds);
    addToSet(this._rebuiltNodeIds, queue);

    while (queue.length) {
      const nodeId = queue.pop()!;
      const snapshot = this.getNodeSnapshot(nodeId);
      if (!(snapshot instanceof EntitySnapshot)) continue;
      if (!snapshot || !snapshot.inbound) continue;

      for (const { id, path } of snapshot.inbound) {
        this._setValue(id, path, snapshot.node, false);
        if (this._rebuiltNodeIds.has(id)) continue;

        this._rebuiltNodeIds.add(id);
        queue.push(id);
      }
    }
  }

  /**
   * Transitively removes all orphaned nodes from the graph.
   */
  private _removeOrphanedNodes(nodeIds: Set<NodeId>) {
    const queue = Array.from(nodeIds);
    while (queue.length) {
      const nodeId = queue.pop()!;
      const node = this.getNodeSnapshot(nodeId);
      if (!node) continue;

      this._newNodes[nodeId] = undefined;
      this._editedNodeIds.add(nodeId);

      if (!node.outbound) continue;
      for (const { id, path } of node.outbound) {
        const reference = this._ensureNewSnapshot(id);
        if (removeNodeReference('inbound', reference, nodeId, path)) {
          queue.push(id);
        }
      }
    }
  }

  /**
   * Commits the transaction, returning a new immutable snapshot.
   */
  commit(): EditedSnapshot {
    const { entityTransformer } = this._context;
    const snapshots = { ...this._parent._values };
    for (const id in this._newNodes) {
      const newSnapshot = this._newNodes[id];
      // Drop snapshots that were garbage collected.
      if (newSnapshot === undefined) {
        delete snapshots[id];
      } else {
        if (entityTransformer) {
          const { node } = this._newNodes[id] as EntitySnapshot;
          if (node) entityTransformer(node);
        }
        snapshots[id] = newSnapshot;
      }
    }

    return {
      snapshot: new GraphSnapshot(snapshots),
      editedNodeIds: this._editedNodeIds,
      writtenQueries: this._writtenQueries,
    };
  }

  /**
   * Retrieve the _latest_ version of a node.
   */
  private getDataNodeOfNodeSnapshot(id: NodeId) {
    const snapshot = this.getNodeSnapshot(id);
    return snapshot ? snapshot.node : undefined;
  }

  /**
   * Retrieve the _latest_ version of a node snapshot.
   */
  private getNodeSnapshot(id: NodeId) {
    return id in this._newNodes ? this._newNodes[id] : this._parent.getNodeSnapshot(id);
  }

  /**
   * Set `newValue` at `path` of the value snapshot identified by `id`, without
   * modifying the parent's copy of it.
   *
   * This will not shallow clone objects/arrays along `path` if they were
   * previously cloned during this transaction.
   */
  private _setValue(id: NodeId, path: PathPart[], newValue: any, isEdit = true) {
    if (isEdit) {
      this._editedNodeIds.add(id);
    }

    const parent = this._parent.getNodeSnapshot(id);
    const current = this._ensureNewSnapshot(id);
    current.node = lazyImmutableDeepSet(current.node, parent && parent.node, path, newValue);
  }

  /**
   * Ensures that we have built a new version of a snapshot for node `id` (and
   * that it is referenced by `_newNodes`).
   */
  private _ensureNewSnapshot(id: NodeId): NodeSnapshot {
    let parent;
    if (id in this._newNodes) {
      return this._newNodes[id]!;
    } else {
      parent = this._parent.getNodeSnapshot(id);
    }

    // TODO: We're assuming that the only time we call _ensureNewSnapshot when
    // there is no parent is when the node is an entity.  Can we enforce it, or
    // pass a type through?
    const newSnapshot = parent ? cloneNodeSnapshot(parent) : new EntitySnapshot();
    this._newNodes[id] = newSnapshot;
    return newSnapshot;
  }

  /**
   * Ensures that there is a ParameterizedValueSnapshot for the given field.
   */
  _ensureParameterizedValueSnapshot(containerId: NodeId, path: PathPart[], field: DynamicFieldWithArgs) {
    const fieldId = nodeIdForParameterizedValue(containerId, path, field.args);

    // We're careful to not edit the container unless we absolutely have to.
    // (There may be no changes for this parameterized value).
    const containerSnapshot = this.getNodeSnapshot(containerId);
    if (!containerSnapshot || !hasNodeReference(containerSnapshot, 'outbound', fieldId, path)) {
      // We need to construct a new snapshot otherwise.
      const newSnapshot = new ParameterizedValueSnapshot();
      addNodeReference('inbound', newSnapshot, containerId, path);
      this._newNodes[fieldId] = newSnapshot;

      // Ensure that the container points to it.
      addNodeReference('outbound', this._ensureNewSnapshot(containerId), fieldId, path);
    }

    return fieldId;
  }
}

/**
 * Generate a stable id for a parameterized value.
 */
export function nodeIdForParameterizedValue(containerId: NodeId, path: PathPart[], args?: JsonObject) {
  return `${containerId}❖${JSON.stringify(path)}❖${JSON.stringify(args)}`;
}
