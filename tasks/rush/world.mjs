// RushWorld: a World whose moves are validated against the real sliding-block
// board. Illegal moves (into a wall or another vehicle) are rejected and logged,
// never silently applied. The position map the predicates read is updated only
// on legal moves, so attribution stays truthful.

import { World } from '../../engine/index.mjs';
import { movesFor, applyMove, isGoal, SIZE, EXIT_ROW } from './rush.mjs';

export class RushWorld extends World {
  constructor(task, opts = {}) {
    super(task, opts);
    this.board = task.rush.board.map((v) => ({ ...v }));
    this.illegalMoves = 0;
  }

  static create(task, opts = {}) {
    return new RushWorld(task, opts);
  }

  step(action) {
    if (this.done) throw new Error('world already terminated');
    if (action?.type !== 'move') return super.step(action);

    const { id, delta } = action.args ?? {};
    const legal = movesFor(this.board, id);
    const match = legal.find((m) => m.id === id && m.delta === Number(delta));
    if (!match) {
      this.illegalMoves++;
      // Log as an invalid action through the base engine's reject path by
      // handing it an unknown action type; it records ok:false without changing
      // state, and the clock still advances (a wasted turn costs neglect).
      return super.step({ type: '__illegal_move', args: { id, delta } });
    }

    this.board = applyMove(this.board, match);
    const pos = {};
    for (const v of this.board) pos[v.id] = { row: v.row, col: v.col };
    const next = { ...this.state, pos, moves: (this.state.moves ?? 0) + 1 };
    return super.step({ type: '__rush_sync', args: { action, state: next } });
  }

  profile() {
    const p = super.profile();
    return { ...p, illegalMoves: this.illegalMoves, solved: isGoal(this.board) };
  }
}