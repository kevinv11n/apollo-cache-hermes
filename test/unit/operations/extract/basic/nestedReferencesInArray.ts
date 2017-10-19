import { extract } from '../../../../../src/operations/extract';
import { Serializeable, StaticNodeId } from '../../../../../src/schema';
import { createSnapshot } from '../../../../helpers';

const { QueryRoot: QueryRootId } = StaticNodeId;

describe.skip(`operations.extract`, () => {
  describe(`nested references in an array`, () => {

    let extractResult: Serializeable.GraphSnapshot;
    beforeAll(() => {
      const snapshot = createSnapshot(
        {
          one: {
            two: [
              { three: { id: 0 } },
              { three: { id: 1 } },
            ],
          },
        },
        `{ 
            one {
              two {
                three { id }
              }
            }
        }`,
      ).snapshot;

      extractResult = extract(snapshot);
    });

    it(`extracts JSON serialization object`, () => {
      expect(extractResult).to.deep.eq({
        [QueryRootId]: {
          type: Serializeable.NodeSnapshotType.EntitySnapshot,
          outbound: [
            { id: '0', path: ['one', 'two', 0, 'three'] },
            { id: '1', path: ['one', 'two', 1, 'three'] },
          ],
          data: {
            one: {
              two: [{}, {}],
            },
          },
        },
        '0': {
          type: Serializeable.NodeSnapshotType.EntitySnapshot,
          inbound: [{ id: QueryRootId, path: ['one', 'two', 0, 'three'] }],
          data: { id: 0 },
        },
        '1': {
          type: Serializeable.NodeSnapshotType.EntitySnapshot,
          inbound: [{ id: QueryRootId, path: ['one', 'two', 1, 'three'] }],
          data: { id: 1 },
        },
      });
    });

  });
});