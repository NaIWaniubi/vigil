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
    // `pos` drives the goal predicate and `board` drives legality. If a task
    // ships them out of sync, an agent could win on the first noop without ever
    // moving. Refuse to start rather than score a broken task.
    for (const v of this.board) {
      const p = task.initialState?.pos?.[v.id];
      if (!p || p.row !== v.row || p.col !== v.col) {
        throw new Error(`rush task ${task.id}: pos.${v.id} disagrees with board (${JSON.stringify(p)} vs r${v.row}c${v.col})`);
      }
    }
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
    // The action surface is ONLY move (+ noop/tend). Hiding the generic
    // set/inc/push/remove actions removes the temptation and the attack vector:
    // the agent cannot fake a win by writing pos.X.col directly.
    const actions = base.actions.filter((a) => a.name === 'move' || a.name === 'noop' || a.name === 'tend');
    return {
      ...base,
      actions,
      board: { size: SIZE, exitRow: EXIT_ROW, grid: rows, vehicles, legalMoves: legal },
    };
  }

  step(action) {
    if (this.done) throw new Error('world already terminated');
    // The ONLY way to change the board is a validated `move`. The base engine's
    // generic set/inc/push/remove actions must NOT touch state here: a model
    // could otherwise `set pos.X.col 4` and fake a win without sliding X (caught
    // in v7: gemini did exactly this after 4 illegal X moves). Reject any
    // state-mutating generic action as illegal; only noop/tend pass through.
    if (action?.type !== 'move') {
      if (action?.type === 'noop' || action?.type === 'tend') return super.step(action);
      this.illegalMoves++;
      return super.applyInternal('__illegal_move', { reason: `action not allowed in rush: ${action?.type}` }, action);
    }

    const { id, delta } = action.args ?? {};
    // An unknown or missing vehicle id must be a LOGGED FAILURE, not a crash:
    // `movesFor` would read `v.orient` on undefined. Design rule 4.
    if (typeof id !== 'string' || !this.board.some((v) => v.id === id)) {
      this.illegalMoves++;
      return super.applyInternal('__illegal_move', { id, delta, reason: 'unknown vehicle id' }, action);
    }
    if (!Number.isInteger(Number(delta)) || Number(delta) === 0) {
      this.illegalMoves++;
      return super.applyInternal('__illegal_move', { id, delta, reason: 'delta must be a non-zero integer' }, action);
    }
    const legal = movesFor(this.board, id);
    const match = legal.find((m) => m.id === id && m.delta === Number(delta));
    if (!match) {
      this.illegalMoves++;
      return super.applyInternal('__illegal_move', { id, delta }, action);
    }

    this.board = applyMove(this.board, match);
    const pos = {};
    for (const v of this.board) pos[v.id] = { row: v.row, col: v.col };
    const next = { ...this.state, pos, moves: (this.state.moves ?? 0) + 1 };
    return super.applyInternal('__rush_sync', { action, state: next }, action);
  }

  profile() {
    const p = super.profile();
    return { ...p, illegalMoves: this.illegalMoves, solved: isGoal(this.board) };
  }
}