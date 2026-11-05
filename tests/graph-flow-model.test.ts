import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphData, GraphLink } from '../packages/pm-schema/graph.ts';
import { buildFlowGraph, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from '../packages/pm-views/graph-flow-model.ts';

function graphData(ids: string[], links: GraphLink[] = []): GraphData {
  return {
    nodes: ids.map(id => ({ id, title: `Title ${id}`, entity: 'document', archived: false, stale: false })),
    links,
    unresolved: [],
    availableRelations: [...new Set(links.map(link => link.kind))].sort(),
  };
}

function relation(id: string, source: string, target: string, kind = 'link'): GraphLink {
  return { id, source, target, kind };
}

test('multiple kinds, same-kind parallel links, reciprocal links and self loops retain distinct geometry metadata', () => {
  const data = graphData(['DOC-2', 'DOC-1'], [
    relation('reverse', 'DOC-2', 'DOC-1', 'related_to'),
    relation('parallel-b', 'DOC-1', 'DOC-2'),
    relation('loop-related', 'DOC-1', 'DOC-1', 'related_to'),
    relation('parallel-a', 'DOC-1', 'DOC-2'),
    relation('blocked', 'DOC-1', 'DOC-2', 'blocked_by'),
    relation('loop-link', 'DOC-1', 'DOC-1'),
  ]);
  const model = buildFlowGraph(data, 'RIGHT');
  assert.deepEqual(model.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.data!.kind })),
    [...data.links].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const metadata = new Map(model.edges.map(edge => [edge.id, edge.data!]));
  assert.deepEqual(metadata.get('blocked'), { kind: 'blocked_by', lane: -1.5, parallelCount: 4 });
  assert.deepEqual(metadata.get('parallel-a'), { kind: 'link', lane: -.5, parallelCount: 4 });
  assert.deepEqual(metadata.get('parallel-b'), { kind: 'link', lane: .5, parallelCount: 4 });
  assert.deepEqual(metadata.get('reverse'), { kind: 'related_to', lane: 1.5, parallelCount: 4 });
  assert.deepEqual(metadata.get('loop-link'), { kind: 'link', lane: 0, parallelCount: 2 });
  assert.deepEqual(metadata.get('loop-related'), { kind: 'related_to', lane: 1, parallelCount: 2 });
  assert.equal(new Set(model.edges.filter(edge => edge.source !== edge.target).map(edge => edge.data!.lane)).size, 4,
    'all directions share one canonical pair normal and have separate physical lanes');
  assert.equal(model.nodes.find(node => node.id === 'DOC-1')!.data.degree, 6, 'a self loop counts as one incident relationship');
  assert.equal(model.nodes.find(node => node.id === 'DOC-2')!.data.degree, 4);
  assert.deepEqual(model.neighbors.get('DOC-1'), new Set(['DOC-1', 'DOC-2']));
});

test('node positions, lane assignments and neighbor ordering are deterministic under DTO reordering', () => {
  const data = graphData(['DOC-3', 'DOC-1', 'DOC-2', 'DOC-4'], [
    relation('c', 'DOC-2', 'DOC-1'),
    relation('a', 'DOC-1', 'DOC-2', 'related_to'),
    relation('b', 'DOC-1', 'DOC-2'),
    relation('loop-b', 'DOC-3', 'DOC-3', 'related_to'),
    relation('loop-a', 'DOC-3', 'DOC-3'),
    relation('cycle', 'DOC-2', 'DOC-3'),
    relation('close-cycle', 'DOC-3', 'DOC-1'),
  ]);
  for (const direction of ['RIGHT', 'DOWN'] as const) {
    const original = buildFlowGraph(data, direction);
    const reversed = buildFlowGraph({ ...data, nodes: [...data.nodes].reverse(), links: [...data.links].reverse() }, direction);
    const rotated = buildFlowGraph({ ...data, nodes: [...data.nodes.slice(1), data.nodes[0]!], links: [...data.links.slice(3), ...data.links.slice(0, 3)] }, direction);
    assert.deepEqual(reversed, original);
    assert.deepEqual(rotated, original);
  }
});

test('general directed cycles remain intact and isolated nodes retain an empty neighborhood', () => {
  const data = graphData(['DOC-4', 'DOC-3', 'DOC-2', 'DOC-1'], [
    relation('one-two', 'DOC-1', 'DOC-2', 'parent'),
    relation('two-three', 'DOC-2', 'DOC-3', 'related_to'),
    relation('three-one', 'DOC-3', 'DOC-1'),
  ]);
  const model = buildFlowGraph(data, 'RIGHT');
  assert.deepEqual(model.nodes.map(node => node.id), ['DOC-1', 'DOC-2', 'DOC-3', 'DOC-4']);
  assert.equal(model.edges.length, 3);
  for (const link of data.links) {
    const edge = model.edges.find(edge => edge.id === link.id)!;
    assert.equal(edge.source, link.source, 'layout adaptation never reverses cycle edges');
    assert.equal(edge.target, link.target);
    assert.equal(edge.data!.kind, link.kind);
  }
  assert.deepEqual(model.neighbors, new Map([
    ['DOC-1', new Set(['DOC-2', 'DOC-3'])],
    ['DOC-2', new Set(['DOC-1', 'DOC-3'])],
    ['DOC-3', new Set(['DOC-2', 'DOC-1'])],
    ['DOC-4', new Set()],
  ]));
  assert.deepEqual(model.nodes.map(node => node.data.degree), [2, 2, 2, 0]);
});

test('horizontal and vertical fallback grids are finite and non-overlapping', () => {
  const data = graphData(Array.from({ length: 19 }, (_, index) => `DOC-${String(index + 1).padStart(2, '0')}`));
  for (const direction of ['RIGHT', 'DOWN'] as const) {
    const model = buildFlowGraph(data, direction);
    for (const [index, node] of model.nodes.entries()) {
      assert.ok(Number.isFinite(node.position.x) && Number.isFinite(node.position.y));
      for (const other of model.nodes.slice(index + 1)) {
        assert.ok(node.position.x + GRAPH_NODE_WIDTH <= other.position.x
          || other.position.x + GRAPH_NODE_WIDTH <= node.position.x
          || node.position.y + GRAPH_NODE_HEIGHT <= other.position.y
          || other.position.y + GRAPH_NODE_HEIGHT <= node.position.y,
        `${node.id} must not overlap ${other.id} in the ${direction} fallback`);
      }
    }
    const first = model.nodes[0]!.position;
    const second = model.nodes[1]!.position;
    if (direction === 'RIGHT') {
      assert.ok(second.x > first.x);
      assert.equal(second.y, first.y);
    } else {
      assert.ok(second.y > first.y);
      assert.equal(second.x, first.x);
    }
  }
});


test('frozen DTOs are not mutated and later React Flow edits cannot change DTOs or another adapter instance', () => {
  const data = graphData(['DOC-2', 'DOC-1'], [relation('link', 'DOC-1', 'DOC-2')]);
  data.unresolved.push({ source: 'DOC-1', target: 'Unavailable', reason: 'missing' });
  const snapshot = structuredClone(data);
  for (const node of data.nodes) Object.freeze(node);
  for (const link of data.links) Object.freeze(link);
  for (const issue of data.unresolved) Object.freeze(issue);
  Object.freeze(data.nodes);
  Object.freeze(data.links);
  Object.freeze(data.unresolved);
  Object.freeze(data.availableRelations);
  Object.freeze(data);
  const model = buildFlowGraph(data, 'RIGHT');
  const independent = buildFlowGraph(data, 'RIGHT');
  for (const node of model.nodes) {
    assert.notEqual(node.data.entity, data.nodes.find(entity => entity.id === node.id));
  }
  const changedNode = model.nodes[0]!;
  const changedEdge = model.edges[0]!;
  changedNode.position.x = -1000;
  changedNode.data.entity.title = 'Changed only in this flow';
  changedNode.data.degree = 900;
  changedNode.style!.width = 1;
  changedEdge.source = 'CHANGED';
  changedEdge.data!.kind = 'changed';
  changedEdge.data!.lane = 99;
  model.neighbors.get('DOC-1')!.clear();
  assert.deepEqual(data, snapshot);
  assert.deepEqual(independent, buildFlowGraph(snapshot, 'RIGHT'));
});

test('empty graphs do not invent nodes, edges or neighborhoods', () => {
  for (const direction of ['RIGHT', 'DOWN'] as const) {
    assert.deepEqual(buildFlowGraph(graphData([]), direction), { nodes: [], edges: [], neighbors: new Map() });
  }
});
