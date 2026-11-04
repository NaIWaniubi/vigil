// RushWorld: a World whose moves are validated against the real sliding-block
// board. Illegal moves (into a wall or another vehicle) are rejected and logged,
// never silently applied. The position map the predicates read is updated only
// on legal moves, so attribution stays truthful.

import { World } from '../../engine/index.mjs';
import { movesFor, applyMove, isGoal, SIZE, EXIT_ROW, occupancy } from './rush.mjs';

export class RushWorld extends World {
  constructor(task, opts = {}) {
    super(task, opts);
    this.board = task.rush.board.map((v) => ({ ...v }));
    this.illegalMoves = 0;
  }

  static create(task, opts = {}) {
    return new RushWorld(task, opts);
  }

  /**
   * The agent must see the BOARD, not just coordinates: vehicle shapes,
   * orientations, and an ASCII grid. Without this it cannot reason about which
   * slides are legal and flails (measured: 94/94 illegal moves). The oracle and
   * solution are never exposed — only the current visible configuration.
   */
  observe() {
    const base = super.observe();
    const grid = occupancy(this.board);
    const rows = [];
    for (let r = 0; r < SIZE; r++) {
      let line = '';
      for (let c = 0; c < SIZE; c++) line += grid[r][c] ?? '.';
      rows.push(line + (r === EXIT_ROW ? '  <- exit row' : ''));
    }
    const vehicles = this.board.map((v) => ({
      id: v.id, orient: v.orient, len: v.len, row: v.row, col: v.col,
    }));
    const legal = {};
    for (const v of this.board) {
      legal[v.id] = movesFor(this.board, v.id).map((m) => m.delta);
    }
    return {
      ...base,
      board: { size: SIZE, exitRow: EXIT_ROW, grid: rows, vehicles, legalMoves: legal },
    };
  }

  step(action) {
    if (this.done) throw new Error('world already terminated');
    if (action?.type !== 'move') return super.step(action);

    const { id, delta } = action.args ?? {};
    const legal = movesFor(this.board, id);
    const match = legal.find((m) => m.id === id && m.delta === Number(delta));
    if (!match) {
      this.illegalMoves++;
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