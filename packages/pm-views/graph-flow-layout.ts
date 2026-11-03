import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphDirection, type GraphFlowModel } from './graph-flow-model.ts';

/**
 * Each invocation owns a real ELK Worker and terminates it on every exit path.
 * Abort the previous invocation when replacing data or changing query scope;
 * cancellation rejects with AbortError, never with partial or fallback positions.
 * On failure the canvas retains the adapter's movable grid and can offer retry.
 */
export function layoutFlowGraph(model: GraphFlowModel, direction: GraphDirection, signal?: AbortSignal): Promise<Map<string, { x: number; y: number }>> {
  if (signal?.aborted) return Promise.reject(new DOMException('Graph layout cancelled', 'AbortError'));
  if (model.nodes.length === 0) return Promise.resolve(new Map());

  const { promise, resolve, reject } = Promise.withResolvers<Map<string, { x: number; y: number }>>();
  let worker: Worker | undefined;
  let elk: InstanceType<typeof ELK> | undefined;
  let settled = false;
  function finish(positions?: Map<string, { x: number; y: number }>, error?: unknown) {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    worker?.removeEventListener('error', onWorkerError);
    worker?.removeEventListener('messageerror', onMessageError);
    // Retain the raw worker for cleanup if ELK's constructor itself throws.
    if (elk) elk.terminateWorker(); else worker?.terminate();
    if (positions) resolve(positions); else reject(error);
  }
  function onAbort() {
    finish(undefined, new DOMException('Graph layout cancelled', 'AbortError'));
  }
  function onWorkerError(event: ErrorEvent) {
    finish(undefined, new Error(event.message || 'Graph layout worker failed to load or execute'));
  }
  function onMessageError() {
    finish(undefined, new Error('Graph layout worker returned an unreadable message'));
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { onAbort(); return promise; }

  try {
    elk = new ELK({
      algorithms: ['layered'],
      workerFactory: () => {
        worker = new Worker(elkWorkerUrl);
        worker.addEventListener('error', onWorkerError);
        worker.addEventListener('messageerror', onMessageError);
        return worker;
      },
    });
    void elk.layout({
      id: 'knowledge-graph-root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': direction,
        'elk.randomSeed': '1',
        'elk.padding': '[top=40,left=40,bottom=40,right=40]',
        'elk.spacing.nodeNode': '64',
        // Layered layout with disconnected subgraphs packed into their own compact blocks.
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '64',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
        'elk.layered.mergeEdges': 'false',
      },
      children: model.nodes.map(node => ({ id: node.id, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT })),
      edges: model.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    }).then(result => {
      if (settled) return;
      const children = new Map(result.children?.map(node => [node.id, node]));
      const positions = new Map<string, { x: number; y: number }>();
      // Only requested IDs can leave this function, even after a late result.
      for (const node of model.nodes) {
        const placed = children.get(node.id);
        if (placed?.x === undefined || placed.y === undefined || !Number.isFinite(placed.x) || !Number.isFinite(placed.y)) {
          throw new Error('Graph layout did not return a finite position for every node');
        }
        positions.set(node.id, { x: placed.x, y: placed.y });
      }
      finish(positions);
    }).catch((error: unknown) => { finish(undefined, error); });
  } catch (error) {
    finish(undefined, error);
  }
  return promise;
}
