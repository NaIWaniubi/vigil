// Authored multi-file mini-repos for vigil-swe.
//
// Each repo is 3-6 real ES modules that IMPORT each other, so a change in one
// file can break behaviour owned by another (regression coupling). Every repo
// ships:
//   initial    — the buggy starting repository (some requirements already hold)
//   oracle     — a complete correct source for EVERY file (joint solution)
//   requirements — ordered checks; each runs REAL code from the whole repo
//   naiveFix   — a proven regression fixture: a single-file "fix" that satisfies
//                a LATER requirement while breaking an EARLIER one. This is the
//                coupling proof the self-audit and tests exercise.
//
// Checks are data: { entry, call, args, expect }. The verifier loads the whole
// repo (cross-module imports rewritten to data: URLs), calls `entry.call(...args)`
// and deep-compares the result with `expect`.

export const MODULES = [
  // -------------------------------------------------------------------------
  // (a) reactive store + computed selectors + subscription manager
  // -------------------------------------------------------------------------
  {
    id: 'STORE',
    title: 'reactive-store',
    entry: 'src/index.mjs',
    initial: {
      'src/emitter.mjs': `// emitter.mjs — subscription manager
export function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {
        const arr = listeners.get(event) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, payload) {
      const arr = listeners.get(event) || [];
      for (const fn of arr) fn(payload);
    },
    count(event) {
      return (listeners.get(event) || []).length;
    },
  };
}
`,
      'src/store.mjs': `// store.mjs — reactive state container
import { createEmitter } from './emitter.mjs';

export function createStore(initial) {
  let state = { ...initial };
  const emitter = createEmitter();
  return {
    getState() { return state; },
    setState(patch) {
      state = { ...state, ...patch };
      emitter.emit('change', state);
    },
    subscribe(fn) { return emitter.on('change', fn); },
    listenerCount() { return emitter.count('change'); },
  };
}
`,
      'src/selectors.mjs': `// selectors.mjs — derived views over a store
export function computed(store, deps, fn) {
  return { get: () => fn(store.getState()) };
}

export function select(store, key) {
  return store.getState()[key];
}
`,
      'src/index.mjs': `// index.mjs — public façade tying the modules together
import { createStore } from './store.mjs';
import { computed } from './selectors.mjs';

export function makeCart() {
  const store = createStore({ items: [], coupon: 0 });
  const total = computed(store, ['items', 'coupon'], (s) => {
    const sum = s.items.reduce((acc, it) => acc + it.price * it.qty, 0);
    return sum - s.coupon;
  });
  return {
    add(item) { store.setState({ items: [...store.getState().items, item] }); },
    applyCoupon(n) { store.setState({ coupon: n }); },
    total() { return total.get(); },
    subscribe(fn) { return store.subscribe(fn); },
    listenerCount() { return store.listenerCount(); },
  };
}
`,
    },
    oracle: {
      'src/emitter.mjs': `// emitter.mjs — subscription manager
export function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {
        const arr = listeners.get(event) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, payload) {
      // Snapshot so a listener that unsubscribes mid-emit cannot skip a peer.
      const arr = [...(listeners.get(event) || [])];
      for (const fn of arr) fn(payload);
    },
    count(event) {
      return (listeners.get(event) || []).length;
    },
  };
}
`,
      'src/store.mjs': `// store.mjs — reactive state container
import { createEmitter } from './emitter.mjs';

export function createStore(initial) {
  let state = { ...initial };
  const emitter = createEmitter();
  return {
    getState() { return state; },
    setState(patch) {
      const changed = Object.keys(patch).some((k) => state[k] !== patch[k]);
      state = { ...state, ...patch };
      if (changed) emitter.emit('change', state);
    },
    subscribe(fn) { return emitter.on('change', fn); },
    listenerCount() { return emitter.count('change'); },
  };
}
`,
      'src/selectors.mjs': `// selectors.mjs — derived views over a store
export function computed(store, deps, fn) {
  let cached;
  let lastState;
  return {
    get() {
      const s = store.getState();
      if (s !== lastState) {
        cached = fn(s);
        lastState = s;
      }
      return cached;
    },
  };
}

export function select(store, key) {
  return store.getState()[key];
}
`,
      'src/index.mjs': `// index.mjs — public façade tying the modules together
import { createStore } from './store.mjs';
import { computed } from './selectors.mjs';

export function makeCart() {
  const store = createStore({ items: [], coupon: 0 });
  const total = computed(store, ['items', 'coupon'], (s) => {
    const sum = s.items.reduce((acc, it) => acc + it.price * it.qty, 0);
    return Math.max(0, sum - s.coupon);
  });
  return {
    add(item) { store.setState({ items: [...store.getState().items, item] }); },
    applyCoupon(n) { store.setState({ coupon: n }); },
    total() { return total.get(); },
    subscribe(fn) { return store.subscribe(fn); },
    listenerCount() { return store.listenerCount(); },
  };
}
`,
    },
    requirements: [
      {
        id: 'req-total',
        text: 'Cart totals stay live: add({price:5,qty:2}) → total() 10, then add({price:3,qty:1}) → total() 13. Each add notifies subscribers.',
        check: { entry: 'src/index.mjs', call: 'makeCart', scenario: 'cart-total', expect: { first: 10, final: 13 } },
      },
      {
        id: 'req-unsubscribe',
        text: 'subscribe(fn) returns an unsubscribe function; after calling it, further setState must not invoke fn and listenerCount() drops back.',
        check: { entry: 'src/index.mjs', call: 'makeCart', scenario: 'cart-unsubscribe', expect: { calls: 1, listeners: 0 } },
      },
      {
        id: 'req-memo',
        text: 'computed(store, deps, fn) must memoize: repeated get() with unchanged state must not re-run fn (it counts its own invocations).',
        check: { entry: 'src/selectors.mjs', call: 'computed', scenario: 'memo', expect: { value: 7, runs: 1 } },
      },
      {
        id: 'req-noop-set',
        text: 'setState with identical values must not notify subscribers (no spurious change events).',
        check: { entry: 'src/store.mjs', call: 'createStore', scenario: 'noop-set', expect: 1 },
      },
      {
        id: 'req-clamp',
        text: 'Cart total must never go negative: a coupon larger than the subtotal clamps the total to 0.',
        check: { entry: 'src/index.mjs', call: 'makeCart', scenario: 'cart-clamp', expect: 0 },
      },
      {
        id: 'req-emit-snapshot',
        text: 'A listener that unsubscribes itself during an emit must not prevent the remaining listeners from receiving that same event.',
        check: { entry: 'src/emitter.mjs', call: 'createEmitter', scenario: 'emit-self-unsub', expect: { a: 1, b: 1 } },
      },
    ],
    // Regression coupling (naive single-file fix), verified by the fixture test:
    // req-memo (revealed 3rd) asks computed() to memoize. The naive fix caches
    // the FIRST computation forever, which satisfies req-memo — but breaks the
    // EARLIER req-total (revealed 1st): the façade's total selector stops
    // seeing new items after the first add. One file changed, later requirement
    // passes, earlier one regresses. The oracle invalidates on state identity.
    naiveFix: {
      file: 'src/selectors.mjs',
      satisfies: 'req-memo',
      breaks: 'req-total',
      source: `// selectors.mjs — naive "fix": cache the first computation forever
export function computed(store, deps, fn) {
  let cached;
  let done = false;
  return {
    get() {
      if (!done) {
        cached = fn(store.getState());
        done = true;
      }
      return cached;
    },
  };
}

export function select(store, key) {
  return store.getState()[key];
}
`,
    },
  },

  // -------------------------------------------------------------------------
  // (b) event-sourced todo: event log + projections + undo
  // -------------------------------------------------------------------------
  {
    id: 'TODO',
    title: 'event-sourced-todo',
    entry: 'src/index.mjs',
    initial: {
      'src/events.mjs': `// events.mjs — append-only event log
export function createLog() {
  const events = [];
  return {
    append(type, payload) {
      events.push({ type, payload, seq: events.length });
      return events.length - 1;
    },
    all() { return [...events]; },
    since(seq) { return events.filter((e) => e.seq >= seq); },
  };
}
`,
      'src/projections.mjs': `// projections.mjs — rebuild read models from the event log
export function projectTodos(events) {
  const todos = {};
  for (const e of events) {
    if (e.type === 'added') todos[e.payload.id] = { id: e.payload.id, title: e.payload.title, done: false };
    if (e.type === 'completed') {
      const t = todos[e.payload.id];
      if (t) t.done = true;
    }
    if (e.type === 'removed') delete todos[e.payload.id];
  }
  return Object.values(todos);
}

export function projectStats(events) {
  const todos = projectTodos(events);
  return { total: todos.length, done: todos.filter((t) => t.done).length };
}
`,
      'src/undo.mjs': `// undo.mjs — inverse-event stack
import { projectTodos } from './projections.mjs';

export function createUndo(log) {
  return {
    undoLast() {
      const events = log.all();
      const last = events[events.length - 1];
      if (!last) return false;
      if (last.type === 'added') log.append('removed', { id: last.payload.id });
      if (last.type === 'removed') log.append('added', last.payload);
      return true;
    },
  };
}
`,
      'src/index.mjs': `// index.mjs — command façade
import { createLog } from './events.mjs';
import { projectTodos, projectStats } from './projections.mjs';
import { createUndo } from './undo.mjs';

export function createTodoApp() {
  const log = createLog();
  const undo = createUndo(log);
  let nextId = 1;
  return {
    add(title) {
      const id = nextId++;
      log.append('added', { id, title });
      return id;
    },
    complete(id) { log.append('completed', { id }); },
    remove(id) { log.append('removed', { id }); },
    undo() { return undo.undoLast(); },
    todos() { return projectTodos(log.all()); },
    stats() { return projectStats(log.all()); },
    eventCount() { return log.all().length; },
  };
}
`,
    },
    oracle: {
      'src/events.mjs': `// events.mjs — append-only event log
export function createLog() {
  const events = [];
  return {
    append(type, payload) {
      events.push({ type, payload, seq: events.length });
      return events.length - 1;
    },
    all() { return [...events]; },
    since(seq) { return events.filter((e) => e.seq >= seq); },
  };
}
`,
      'src/projections.mjs': `// projections.mjs — rebuild read models from the event log
export function projectTodos(events) {
  const todos = {};
  for (const e of events) {
    if (e.type === 'added') todos[e.payload.id] = { id: e.payload.id, title: e.payload.title, done: false };
    if (e.type === 'completed') {
      const t = todos[e.payload.id];
      if (t) t.done = true;
    }
    if (e.type === 'reopened') {
      const t = todos[e.payload.id];
      if (t) t.done = false;
    }
    if (e.type === 'renamed') {
      const t = todos[e.payload.id];
      if (t) t.title = e.payload.title;
    }
    if (e.type === 'removed') delete todos[e.payload.id];
  }
  return Object.values(todos).sort((a, b) => a.id - b.id);
}

export function projectStats(events) {
  const todos = projectTodos(events);
  return { total: todos.length, done: todos.filter((t) => t.done).length };
}
`,
      'src/undo.mjs': `// undo.mjs — inverse-event stack
import { projectTodos } from './projections.mjs';

export function createUndo(log) {
  return {
    undoLast() {
      const events = log.all();
      const last = events[events.length - 1];
      if (!last) return false;
      if (last.type === 'added') log.append('removed', { id: last.payload.id });
      if (last.type === 'removed') {
        // Restore the todo as it was just before removal (title, done flag).
        const before = events.slice(0, -1);
        const t = projectTodos(before).find((x) => x.id === last.payload.id);
        log.append('added', t ? { id: t.id, title: t.title } : { id: last.payload.id, title: '' });
        if (t?.done) log.append('completed', { id: t.id });
      }
      if (last.type === 'completed') log.append('reopened', { id: last.payload.id });
      if (last.type === 'renamed') {
        const before = events.slice(0, -1);
        const t = projectTodos(before).find((x) => x.id === last.payload.id);
        if (t) log.append('renamed', { id: t.id, title: t.title });
      }
      return true;
    },
  };
}
`,
      'src/index.mjs': `// index.mjs — command façade
import { createLog } from './events.mjs';
import { projectTodos, projectStats } from './projections.mjs';
import { createUndo } from './undo.mjs';

export function createTodoApp() {
  const log = createLog();
  const undo = createUndo(log);
  let nextId = 1;
  return {
    add(title) {
      const id = nextId++;
      log.append('added', { id, title });
      return id;
    },
    complete(id) { log.append('completed', { id }); },
    reopen(id) { log.append('reopened', { id }); },
    rename(id, title) { log.append('renamed', { id, title }); },
    remove(id) { log.append('removed', { id }); },
    undo() { return undo.undoLast(); },
    todos() { return projectTodos(log.all()); },
    stats() { return projectStats(log.all()); },
    eventCount() { return log.all().length; },
  };
}
`,
    },
    requirements: [
      {
        id: 'req-add-complete',
        text: 'add("a"), add("b"), complete(first) → stats() returns {total:2, done:1} and todos() lists both with correct done flags.',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-basic', expect: { total: 2, done: 1 } },
      },
      {
        id: 'req-undo-add',
        text: 'undo() after add() removes that todo (inverse event), and todos() no longer contains it.',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-undo-add', expect: [] },
      },
      {
        id: 'req-reopen',
        text: 'A completed todo can be reopened: complete(id) then reopen(id) → done flag is false again and stats().done is 0.',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-reopen', expect: { total: 1, done: 0 } },
      },
      {
        id: 'req-undo-complete',
        text: 'undo() after complete(id) reopens the todo (inverse of completed is reopened).',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-undo-complete', expect: { total: 1, done: 0 } },
      },
      {
        id: 'req-rename',
        text: 'rename(id, title) updates the title in projections without changing done flags or ids: add("old"), complete(id), rename(id,"new") → [{id, title:"new", done:true}].',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-rename', expect: [{ id: 1, title: 'new', done: true }] },
      },
      {
        id: 'req-undo-remove',
        text: 'undo() after remove(id) restores the todo with its original title.',
        check: { entry: 'src/index.mjs', call: 'createTodoApp', scenario: 'todo-undo-remove', expect: [{ id: 1, title: 'keep', done: false }] },
      },
    ],
    // Regression coupling (naive single-file fix), verified by the fixture test:
    // req-rename (revealed 5th) asks the projection to apply `renamed` events.
    // The naive fix rewrites projectTodos to handle renamed — but drops the
    // `reopened` branch in the rewrite, breaking the EARLIER req-reopen
    // (revealed 3rd): complete→reopen now leaves done:true. One file changed,
    // the later requirement passes, the earlier one regresses. The oracle
    // handles both events simultaneously.
    naiveFix: {
      file: 'src/projections.mjs',
      satisfies: 'req-rename',
      breaks: 'req-reopen',
      source: `// projections.mjs — naive "fix" for rename: rebuild the todo from the payload
export function projectTodos(events) {
  const todos = {};
  for (const e of events) {
    if (e.type === 'added') todos[e.payload.id] = { id: e.payload.id, title: e.payload.title, done: false };
    if (e.type === 'completed') {
      const t = todos[e.payload.id];
      if (t) t.done = true;
    }
    if (e.type === 'renamed') {
      const t = todos[e.payload.id];
      if (t) todos[e.payload.id] = { id: t.id, title: e.payload.title, done: t.done };
    }
    if (e.type === 'removed') delete todos[e.payload.id];
    // NOTE: reopened events are silently dropped in this rewrite.
  }
  return Object.values(todos).sort((a, b) => a.id - b.id);
}

export function projectStats(events) {
  const todos = projectTodos(events);
  return { total: todos.length, done: todos.filter((t) => t.done).length };
}
`,
    },
  },

  // -------------------------------------------------------------------------
  // (c) URL router + middleware chain + query parser
  // -------------------------------------------------------------------------
  {
    id: 'ROUTER',
    title: 'url-router',
    entry: 'src/index.mjs',
    initial: {
      'src/query.mjs': `// query.mjs — query-string parser
export function parseQuery(search) {
  const out = {};
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return out;
  for (const pair of s.split('&')) {
    const [k, v] = pair.split('=');
    out[k] = v ?? '';
  }
  return out;
}
`,
      'src/middleware.mjs': `// middleware.mjs — onion chain
export function compose(middlewares) {
  return function run(ctx) {
    let i = 0;
    function next() {
      const fn = middlewares[i++];
      if (fn) fn(ctx, next);
    }
    next();
    return ctx;
  };
}
`,
      'src/router.mjs': `// router.mjs — path table with :params
import { parseQuery } from './query.mjs';
import { compose } from './middleware.mjs';

export function createRouter() {
  const routes = [];
  const stack = [];
  return {
    use(fn) { stack.push(fn); },
    add(method, pattern, handler) { routes.push({ method, pattern, handler }); },
    handle(method, url) {
      const [path, search = ''] = url.split('?');
      const ctx = { method, path, query: parseQuery(search), params: {}, status: 404, body: null, trail: [] };
      for (const r of routes) {
        if (r.method !== method) continue;
        const keys = r.pattern.split('/');
        const parts = path.split('/');
        if (keys.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].startsWith(':')) params[keys[i].slice(1)] = parts[i];
          else if (keys[i] !== parts[i]) { ok = false; break; }
        }
        if (!ok) continue;
        ctx.params = params;
        const chain = compose([...stack, (c) => { c.status = 200; c.body = r.handler(c); }]);
        return chain(ctx);
      }
      return ctx;
    },
  };
}
`,
      'src/index.mjs': `// index.mjs — tiny app façade
import { createRouter } from './router.mjs';

export function createApp() {
  const router = createRouter();
  router.use((ctx, next) => { ctx.trail.push('log'); next(); });
  router.add('GET', '/users/:id', (ctx) => ({ user: ctx.params.id, q: ctx.query }));
  router.add('GET', '/health', () => ({ ok: true }));
  return {
    request(method, url) { return router.handle(method, url); },
    use(fn) { router.use(fn); },
    add(method, pattern, handler) { router.add(method, pattern, handler); },
  };
}
`,
    },
    oracle: {
      'src/query.mjs': `// query.mjs — query-string parser
export function parseQuery(search) {
  const out = {};
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return out;
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawK = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawV = eq >= 0 ? pair.slice(eq + 1) : '';
    const k = decodeURIComponent(rawK.replace(/\\+/g, ' '));
    const v = decodeURIComponent(rawV.replace(/\\+/g, ' '));
    if (Object.hasOwn(out, k)) {
      out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}
`,
      'src/middleware.mjs': `// middleware.mjs — onion chain
export function compose(middlewares) {
  return function run(ctx) {
    let i = 0;
    function next() {
      const fn = middlewares[i++];
      if (fn) fn(ctx, next);
    }
    next();
    return ctx;
  };
}
`,
      'src/router.mjs': `// router.mjs — path table with :params
import { parseQuery } from './query.mjs';
import { compose } from './middleware.mjs';

export function createRouter() {
  const routes = [];
  const stack = [];
  return {
    use(fn) { stack.push(fn); },
    add(method, pattern, handler) { routes.push({ method, pattern, handler }); },
    handle(method, url) {
      const [path, search = ''] = url.split('?');
      const ctx = { method, path, query: parseQuery(search), params: {}, status: 404, body: null, trail: [] };
      for (const r of routes) {
        if (r.method !== method) continue;
        const keys = r.pattern.split('/').filter((p) => p !== '');
        const parts = path.split('/').filter((p) => p !== '');
        if (keys.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].startsWith(':')) params[keys[i].slice(1)] = decodeURIComponent(parts[i]);
          else if (keys[i] !== parts[i]) { ok = false; break; }
        }
        if (!ok) continue;
        ctx.params = params;
        const chain = compose([...stack, (c) => { c.status = 200; c.body = r.handler(c); }]);
        return chain(ctx);
      }
      return ctx;
    },
  };
}
`,
      'src/index.mjs': `// index.mjs — tiny app façade
import { createRouter } from './router.mjs';

export function createApp() {
  const router = createRouter();
  router.use((ctx, next) => { ctx.trail.push('log'); next(); });
  router.add('GET', '/users/:id', (ctx) => ({ user: ctx.params.id, q: ctx.query }));
  router.add('GET', '/health', () => ({ ok: true }));
  return {
    request(method, url) { return router.handle(method, url); },
    use(fn) { router.use(fn); },
    add(method, pattern, handler) { router.add(method, pattern, handler); },
  };
}
`,
    },
    requirements: [
      {
        id: 'req-route-param',
        text: 'GET /users/42 routes to the handler with params.id === "42" and status 200; unknown paths return status 404.',
        check: { entry: 'src/index.mjs', call: 'createApp', scenario: 'route-param', expect: { status: 200, user: '42', missing: 404 } },
      },
      {
        id: 'req-middleware-order',
        text: 'Middleware runs in registration order before the handler, each able to mutate ctx (trail must be ["a","b","handler"]).',
        check: { entry: 'src/middleware.mjs', call: 'compose', scenario: 'mw-order', expect: ['a', 'b', 'handler'] },
      },
      {
        id: 'req-query-decode',
        text: 'Query values are URL-decoded, "+" becomes space: parseQuery("?q=hello+world%21") → {q:"hello world!"}.',
        check: { entry: 'src/query.mjs', call: 'parseQuery', args: ['?q=hello+world%21'], expect: { q: 'hello world!' } },
      },
      {
        id: 'req-query-array',
        text: 'Repeated query keys collect into an array: parseQuery("tag=a&tag=b&tag=c") → {tag:["a","b","c"]}.',
        check: { entry: 'src/query.mjs', call: 'parseQuery', args: ['tag=a&tag=b&tag=c'], expect: { tag: ['a', 'b', 'c'] } },
      },
      {
        id: 'req-trailing-slash',
        text: 'Trailing slashes are ignored when matching: GET /health/ still matches /health with status 200.',
        check: { entry: 'src/index.mjs', call: 'createApp', scenario: 'route-trailing', expect: 200 },
      },
      {
        id: 'req-middleware-shortcircuit',
        text: 'Middleware may short-circuit by not calling next(): the handler must not run and the middleware-set status/body survive.',
        check: { entry: 'src/index.mjs', call: 'createApp', scenario: 'mw-shortcircuit', expect: { status: 401, body: 'denied', handlerRan: false } },
      },
    ],
    // Regression coupling (naive single-file fix), verified by the fixture test:
    // req-query-array (revealed 4th) asks repeated keys to collect into arrays.
    // The naive fix ALWAYS collects into arrays and drops URL-decoding, which
    // satisfies req-query-array but breaks the EARLIER req-query-decode
    // (revealed 3rd): values stay raw and single keys become arrays. The oracle
    // decodes first and only collects on repetition.
    naiveFix: {
      file: 'src/query.mjs',
      satisfies: 'req-query-array',
      breaks: 'req-query-decode',
      source: `// query.mjs — naive "fix": always collect values into arrays
export function parseQuery(search) {
  const out = {};
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return out;
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    if (!out[k]) out[k] = [];
    out[k].push(v);
  }
  return out;
}
`,
    },
  },

  // -------------------------------------------------------------------------
  // (d) mini ORM-like query builder + validator + serializer
  // -------------------------------------------------------------------------
  {
    id: 'QUERY',
    title: 'query-builder',
    entry: 'src/index.mjs',
    initial: {
      'src/validate.mjs': `// validate.mjs — schema validation
export function validate(schema, record) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const v = record[field];
    if (rule.required && (v === undefined || v === null)) {
      errors.push({ field, code: 'required' });
      continue;
    }
    if (v === undefined || v === null) continue;
    if (rule.type === 'number' && typeof v !== 'number') errors.push({ field, code: 'type' });
    if (rule.type === 'string' && typeof v !== 'string') errors.push({ field, code: 'type' });
  }
  return errors;
}
`,
      'src/serialize.mjs': `// serialize.mjs — output shaping
export function serialize(record, { omit = [], rename = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (omit.includes(k)) continue;
    out[rename[k] || k] = v;
  }
  return out;
}
`,
      'src/builder.mjs': `// builder.mjs — chainable query over an in-memory table
import { validate } from './validate.mjs';

export function table(name, rows, schema) {
  let data = [...rows];
  const filters = [];
  let sortKey = null;
  let limitN = null;
  const api = {
    where(field, opName, value) {
      filters.push({ field, opName, value });
      return api;
    },
    orderBy(field) { sortKey = field; return api; },
    limit(n) { limitN = n; return api; },
    insert(record) {
      const errors = validate(schema, record);
      if (errors.length) return { ok: false, errors };
      data.push(record);
      return { ok: true };
    },
    exec() {
      let out = data.filter((row) => filters.every((f) => {
        const v = row[f.field];
        if (f.opName === 'eq') return v === f.value;
        if (f.opName === 'gt') return v > f.value;
        if (f.opName === 'lt') return v < f.value;
        return false;
      }));
      if (sortKey) out = [...out].sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1));
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    },
  };
  return api;
}
`,
      'src/index.mjs': `// index.mjs — repository façade
import { table } from './builder.mjs';
import { serialize } from './serialize.mjs';

const schema = {
  id: { type: 'number', required: true },
  name: { type: 'string', required: true },
  age: { type: 'number', required: true },
  secret: { type: 'string' },
};

export function createRepo(rows) {
  const t = table('users', rows, schema);
  return {
    insert(record) { return t.insert(record); },
    adults() { return t.where('age', 'gt', 17).orderBy('age').exec(); },
    byName(name) { return t.where('name', 'eq', name).exec(); },
    public(row) { return serialize(row, { omit: ['secret'], rename: { name: 'displayName' } }); },
  };
}
`,
    },
    oracle: {
      'src/validate.mjs': `// validate.mjs — schema validation
export function validate(schema, record) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const v = record[field];
    if (rule.required && (v === undefined || v === null)) {
      errors.push({ field, code: 'required' });
      continue;
    }
    if (v === undefined || v === null) continue;
    if (rule.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) errors.push({ field, code: 'type' });
    if (rule.type === 'string' && typeof v !== 'string') errors.push({ field, code: 'type' });
    if (rule.min !== undefined && typeof v === 'number' && v < rule.min) errors.push({ field, code: 'min' });
    if (rule.max !== undefined && typeof v === 'number' && v > rule.max) errors.push({ field, code: 'max' });
  }
  return errors;
}
`,
      'src/serialize.mjs': `// serialize.mjs — output shaping
export function serialize(record, { omit = [], rename = {}, pick = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (omit.includes(k)) continue;
    if (pick && !pick.includes(k)) continue;
    out[rename[k] || k] = v;
  }
  return out;
}
`,
      'src/builder.mjs': `// builder.mjs — chainable query over an in-memory table
import { validate } from './validate.mjs';

export function table(name, rows, schema) {
  let data = [...rows];
  const filters = [];
  let sortKey = null;
  let sortDesc = false;
  let limitN = null;
  const api = {
    where(field, opName, value) {
      filters.push({ field, opName, value });
      return api;
    },
    orderBy(field, dir = 'asc') { sortKey = field; sortDesc = dir === 'desc'; return api; },
    limit(n) { limitN = n; return api; },
    insert(record) {
      const errors = validate(schema, record);
      if (errors.length) return { ok: false, errors };
      data.push(record);
      return { ok: true };
    },
    exec() {
      let out = data.filter((row) => filters.every((f) => {
        const v = row[f.field];
        if (f.opName === 'eq') return v === f.value;
        if (f.opName === 'ne') return v !== f.value;
        if (f.opName === 'gt') return v > f.value;
        if (f.opName === 'gte') return v >= f.value;
        if (f.opName === 'lt') return v < f.value;
        if (f.opName === 'lte') return v <= f.value;
        if (f.opName === 'in') return Array.isArray(f.value) && f.value.includes(v);
        return false;
      }));
      if (sortKey) {
        out = [...out].sort((a, b) => {
          const x = a[sortKey];
          const y = b[sortKey];
          const cmp = x > y ? 1 : x < y ? -1 : 0;
          return sortDesc ? -cmp : cmp;
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    },
  };
  return api;
}
`,
      'src/index.mjs': `// index.mjs — repository façade
import { table } from './builder.mjs';
import { serialize } from './serialize.mjs';

const schema = {
  id: { type: 'number', required: true },
  name: { type: 'string', required: true },
  age: { type: 'number', required: true, min: 0, max: 150 },
  secret: { type: 'string' },
};

export function createRepo(rows) {
  const t = table('users', rows, schema);
  return {
    insert(record) { return t.insert(record); },
    adults() { return t.where('age', 'gte', 18).orderBy('age').exec(); },
    byName(name) { return t.where('name', 'eq', name).exec(); },
    oldest(n) { return t.orderBy('age', 'desc').limit(n).exec(); },
    public(row) { return serialize(row, { omit: ['secret'], rename: { name: 'displayName' } }); },
  };
}
`,
    },
    requirements: [
      {
        id: 'req-insert-validate',
        text: 'insert() rejects records missing required fields: inserting {id:1} returns {ok:false} with a required error for name.',
        check: { entry: 'src/index.mjs', call: 'createRepo', scenario: 'insert-invalid', expect: { ok: false, fields: ['name', 'age'] } },
      },
      {
        id: 'req-where-chain',
        text: 'The builder supports strict gt: table(...).where("age","gt",17).orderBy("age").exec() excludes exact 17 and returns ages [20,30] ascending.',
        check: { entry: 'src/builder.mjs', call: 'table', scenario: 'where-chain', expect: [20, 30] },
      },
      {
        id: 'req-range-validate',
        text: 'Schema min/max are enforced: age must be within [0,150]; inserting age 200 fails with code "max".',
        check: { entry: 'src/validate.mjs', call: 'validate', scenario: 'range', expect: [{ field: 'age', code: 'max' }] },
      },
      {
        id: 'req-serialize',
        text: 'serialize supports omit and rename: secret is dropped and name becomes displayName.',
        check: { entry: 'src/serialize.mjs', call: 'serialize', args: [{ id: 1, name: 'ada', secret: 'x' }, { omit: ['secret'], rename: { name: 'displayName' } }], expect: { id: 1, displayName: 'ada' } },
      },
      {
        id: 'req-gte',
        text: 'The builder supports gte: adults() includes exact 18-year-olds (age >= 18), not just age > 17 semantics for floats.',
        check: { entry: 'src/index.mjs', call: 'createRepo', scenario: 'gte-boundary', expect: [18, 21] },
      },
      {
        id: 'req-desc-limit',
        text: 'orderBy(field,"desc") with limit(n) returns the n largest rows, descending.',
        check: { entry: 'src/index.mjs', call: 'createRepo', scenario: 'desc-limit', expect: [30, 21] },
      },
    ],
    // Regression coupling (naive single-file fix), verified by the fixture test:
    // req-gte (revealed 5th) asks the builder to support >=. The naive fix
    // routes BOTH gt and gte through >=, which satisfies req-gte but breaks the
    // EARLIER req-where-chain (revealed 2nd): strict gt now includes the
    // boundary row. The oracle keeps gt strict and adds a separate gte branch.
    naiveFix: {
      file: 'src/builder.mjs',
      satisfies: 'req-gte',
      breaks: 'req-where-chain',
      source: `// builder.mjs — naive "fix": make gt behave as gte everywhere
import { validate } from './validate.mjs';

export function table(name, rows, schema) {
  let data = [...rows];
  const filters = [];
  let sortKey = null;
  let limitN = null;
  const api = {
    where(field, opName, value) {
      filters.push({ field, opName, value });
      return api;
    },
    orderBy(field) { sortKey = field; return api; },
    limit(n) { limitN = n; return api; },
    insert(record) {
      const errors = validate(schema, record);
      if (errors.length) return { ok: false, errors };
      data.push(record);
      return { ok: true };
    },
    exec() {
      let out = data.filter((row) => filters.every((f) => {
        const v = row[f.field];
        if (f.opName === 'eq') return v === f.value;
        if (f.opName === 'gt' || f.opName === 'gte') return v >= f.value;
        if (f.opName === 'lt') return v < f.value;
        return false;
      }));
      if (sortKey) out = [...out].sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1));
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    },
  };
  return api;
}
`,
    },
  },
];

// ---------------------------------------------------------------------------
// Scenario drivers: checks that need multi-step interaction are expressed as
// named scenarios so the check data stays serialisable. Each scenario receives
// the loaded entry module's export and returns the value to compare.
// ---------------------------------------------------------------------------

export const SCENARIOS = {
  'cart-total': (makeCart) => {
    const cart = makeCart();
    let notifications = 0;
    cart.subscribe(() => { notifications++; });
    cart.add({ price: 5, qty: 2 });
    const first = cart.total();
    cart.add({ price: 3, qty: 1 });
    const final = cart.total();
    if (notifications !== 2) return { error: `expected 2 notifications, got ${notifications}` };
    return { first, final };
  },
  'cart-unsubscribe': (makeCart) => {
    const cart = makeCart();
    let calls = 0;
    const off = cart.subscribe(() => { calls++; });
    cart.add({ price: 1, qty: 1 });
    off();
    cart.add({ price: 2, qty: 1 });
    return { calls, listeners: cart.listenerCount() };
  },
  'cart-clamp': (makeCart) => {
    const cart = makeCart();
    cart.add({ price: 5, qty: 1 });
    cart.applyCoupon(50);
    return cart.total();
  },
  'memo': (computed) => {
    let runs = 0;
    const store = {
      _s: { n: 7 },
      getState() { return this._s; },
    };
    const c = computed(store, ['n'], (s) => { runs++; return s.n; });
    const a = c.get();
    const b = c.get();
    return { value: a === b ? a : NaN, runs };
  },
  'noop-set': (createStore) => {
    const store = createStore({ n: 1 });
    let calls = 0;
    store.subscribe(() => { calls++; });
    store.setState({ n: 2 });
    store.setState({ n: 2 });
    return calls;
  },
  'emit-self-unsub': (createEmitter) => {
    const em = createEmitter();
    const seen = { a: 0, b: 0 };
    const offA = em.on('evt', () => { seen.a++; offA(); });
    em.on('evt', () => { seen.b++; });
    em.emit('evt');
    return seen;
  },
  'todo-basic': (createTodoApp) => {
    const app = createTodoApp();
    const a = app.add('a');
    app.add('b');
    app.complete(a);
    return app.stats();
  },
  'todo-undo-add': (createTodoApp) => {
    const app = createTodoApp();
    app.add('a');
    app.undo();
    return app.todos();
  },
  'todo-reopen': (createTodoApp) => {
    const app = createTodoApp();
    const id = app.add('a');
    app.complete(id);
    app.reopen(id);
    return app.stats();
  },
  'todo-undo-complete': (createTodoApp) => {
    const app = createTodoApp();
    const id = app.add('a');
    app.complete(id);
    app.undo();
    return app.stats();
  },
  'todo-rename': (createTodoApp) => {
    const app = createTodoApp();
    const id = app.add('old');
    app.complete(id);
    app.rename(id, 'new');
    return app.todos();
  },
  'todo-undo-remove': (createTodoApp) => {
    const app = createTodoApp();
    const id = app.add('keep');
    app.remove(id);
    app.undo();
    return app.todos();
  },
  'route-param': (createApp) => {
    const app = createApp();
    const hit = app.request('GET', '/users/42');
    const miss = app.request('GET', '/nope');
    return { status: hit.status, user: hit.body?.user ?? null, missing: miss.status };
  },
  'route-trailing': (createApp) => {
    const app = createApp();
    return app.request('GET', '/health/').status;
  },
  'mw-order': (compose) => {
    const ctx = { trail: [] };
    const run = compose([
      (c, next) => { c.trail.push('a'); next(); },
      (c, next) => { c.trail.push('b'); next(); },
      (c) => { c.trail.push('handler'); },
    ]);
    run(ctx);
    return ctx.trail;
  },
  'mw-shortcircuit': (createApp) => {
    const app = createApp();
    let handlerRan = false;
    app.add('GET', '/guarded', () => { handlerRan = true; return 'secret'; });
    app.use((ctx, next) => {
      if (ctx.path === '/guarded') { ctx.status = 401; ctx.body = 'denied'; return; }
      next();
    });
    const res = app.request('GET', '/guarded');
    return { status: res.status, body: res.body, handlerRan };
  },
  'insert-invalid': (createRepo) => {
    const repo = createRepo([]);
    const res = repo.insert({ id: 1 });
    return { ok: res.ok, fields: (res.errors ?? []).map((e) => e.field) };
  },
  'where-chain': (table) => {
    const t = table('users', [
      { id: 1, name: 'a', age: 30 },
      { id: 2, name: 'b', age: 17 },
      { id: 3, name: 'c', age: 20 },
    ], {});
    return t.where('age', 'gt', 17).orderBy('age').exec().map((r) => r.age);
  },
  'gte-boundary': (createRepo) => {
    const repo = createRepo([
      { id: 1, name: 'a', age: 17.5 },
      { id: 2, name: 'b', age: 18 },
      { id: 3, name: 'c', age: 21 },
    ]);
    return repo.adults().map((r) => r.age);
  },
  'desc-limit': (createRepo) => {
    const repo = createRepo([
      { id: 1, name: 'a', age: 30 },
      { id: 2, name: 'b', age: 18 },
      { id: 3, name: 'c', age: 21 },
    ]);
    return repo.oldest(2).map((r) => r.age);
  },
  'range': (validate) => {
    return validate({ age: { type: 'number', min: 0, max: 150 } }, { age: 200 });
  },
};
