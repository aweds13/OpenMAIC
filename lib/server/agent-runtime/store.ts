import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/agent-session/pg';
import { extractObservedUrls } from '@openmaic/storage';
import type { AgentSessionMeta, AgentSessionTransaction } from '@openmaic/storage';
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { notifyDurableAgentEvent } from './event-notify-bus';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { listMaterialText } from './materials-library';

interface AgentSessionStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionStore>;
}

const AGENT_SESSION_STORE_STATE_KEY = Symbol.for('openmaic.agent-session.store');
const globalState = globalThis as typeof globalThis & {
  [AGENT_SESSION_STORE_STATE_KEY]?: AgentSessionStoreState;
};
const storeState = (globalState[AGENT_SESSION_STORE_STATE_KEY] ??= {});

/**
 * 建会话时要登记进 **URL 信任闸**的来源 —— 用户写的提示词 **+ 他登记的材料**。
 *
 * ★ 抽成具名函数是为了**能被测到**：钩子体本身在 `PgAgentSessionStore` 里，
 *   测试只能整库拉起来；这个函数注入一个假 store 就能钉住行为。
 *
 * ★ 材料那一半是 2026-10-07 补的，理由是实测出来的一条自相矛盾：
 *   闸原来只被「`web_search` 结果 / 会话提示词 / 用户消息」喂，**材料库不在其中**
 *   ⇒ agent 在材料文件里读到 URL、照着 `fetch_url`，**被自己的闸拒**
 *   （`url_not_in_session`）。用户"登记资料"这个正确动作没有生效。
 *   实测那次：材料里写着 runoob / start.spring.io / 4 条 github，
 *   而 Oracle / Spring 文档一条都抓不到。
 */
export async function registerBootstrapSessionUrls(
  store: Pick<PgAgentSessionStore, 'registerSessionUrls'>,
  transaction: AgentSessionTransaction,
  meta: AgentSessionMeta,
): Promise<void> {
  await store.registerSessionUrls(meta.id, extractObservedUrls(meta.prompt), 'user', transaction);

  /**
   * 材料库**单独 try**：这一段跑在**建会话那个事务里**，抛出去就等于
   * 「材料读不到 ⇒ 课都建不了」。少几个可信来源是"抓不到"，不是"建不起来" ——
   * 所以这里降级放行。上面那一段（用户提示词）**仍然按原样会中止写入**：
   * 那是用户当场说的话，静默丢掉它才是真问题。
   */
  try {
    const urls = extractObservedUrls(listMaterialText());
    if (urls.length > 0) {
      await store.registerSessionUrls(meta.id, urls, 'user', transaction);
    }
  } catch {
    // 故意吞掉：见上面的取舍。
  }
}

/**
 * Adapt a node-postgres pool to the storage package's transaction contract.
 * Every transaction uses one checked-out client for its entire lifetime.
 */
export function nodePostgresTransaction(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function createAgentSessionStore(connectionString: string): Promise<PgAgentSessionStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  await withSchemaBootstrapLock(pool as unknown as ConnectableQueryable, ensureAgentSessionSchema);
  // URL observations from user-authored prompt/message text are registered
  // inside the same business transaction that creates the session / posts the
  // message (reference session-store semantics), so they commit atomically and
  // a registration failure aborts the write. The hooks run only after the
  // store is constructed, so the closure reference is always assigned.
  const store: PgAgentSessionStore = new PgAgentSessionStore(pool, {
    withTransaction: nodePostgresTransaction(pool),
    // The owner a session write is for, under that owner's identity lock (the
    // transaction's first statement, as the package requires): a retired
    // anonymous owner resolves to the account it was claimed into. This is
    // what makes `readRetirement` tell a stale owner-events stream to
    // reconnect, and `postUserMessage` refuse a request that still presents
    // the retired identity. `POST /api/agent/sessions` refuses one before it
    // gets here; a create racing the claim is written for the account, as if
    // it had committed just before the claim.
    resolveFinalOwner: (transaction, ownerId) => forwardOwnerWrite(transaction, ownerId),
    onSessionCreated: async (transaction, meta): Promise<void> => {
      await registerBootstrapSessionUrls(store, transaction, meta);
    },
    onUserMessagePosted: async (transaction, input): Promise<void> => {
      await store.registerSessionUrls(
        input.session.id,
        extractObservedUrls(input.text),
        'user',
        transaction,
      );
    },
    // Wake the per-session SSE tail (and the running session's runner) in the
    // SAME transaction as the durable append: PG emits NOTIFY only at commit,
    // so the reader wakes exactly when the row becomes visible. Lossy by
    // design — a dropped notification degrades only latency, never
    // correctness, because every stream keeps its fallback poll.
    onSessionEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId: event.sessionId }),
    onOwnerEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'owner', ownerId: event.ownerId }),
    onCancelRequested: (transaction, sessionId): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId }),
  });
  return store;
}

/**
 * Return the process-wide agent-session store, initializing its schema lazily.
 * Failed initialization is cleared so a later request can retry after the
 * database becomes available.
 */
export function getAgentSessionStore(): Promise<PgAgentSessionStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createAgentSessionStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}
