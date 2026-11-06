/**
 * 材料库的服务层：agent 面与人（HTTP）面共用同一份实现，只有 admin 面拿得到删除。
 *
 * ## 为什么要拆这一层
 *
 * 今天「模型删不掉材料」不是靠权限，而是靠
 * `lib/server/agent-runtime/material-tools.ts` 与
 * `lib/server/agent-runtime/material-library-tools.ts` 里**根本没有 delete 代码**。
 * 那是「没人写」的保证：谁补一行 import 就没了，编译器不会拦。拆出服务对象之后，
 * 同一条保证换成两条**结构性**判据：
 *
 * 1. import 判据 —— agent 工具只认 `MaterialAgentService` / `createMaterialAgentService`，
 *    这两个文件的源码文本里不出现 admin 的名字
 *    （`tests/server/materials/material-service-boundary.test.ts` 读文件比对）；
 * 2. 形状判据 —— `createMaterialAgentService` 返回的对象上**不存在** `deleteMaterial` /
 *    `deleteMaterialFolder`，`'deleteMaterial' in service === false`。
 *
 * 两条都不依赖「有人记得别加」。删除能力只长在 `MaterialAdminService` 上，而类型系统
 * 不会把它递给只声明了 agent 面的调用方。
 *
 * ## HTTP 与人共用同一份实现
 *
 * 路由拿的是 `createMaterialAdminService`，与 agent 走的是同一批持久层函数；差别只在
 * **谁能拿到这个对象**。路由的行为因此逐字节不变：它们只是把 `persistence` 从参数里
 * 去掉（工厂已持有），状态码、`libraryRefusal` 的 `reason` 与 `errorCode`、响应体形状
 * 一概照旧。
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

import {
  createMaterialFolder,
  deleteMaterial,
  deleteMaterialFolder,
  listMaterialFolderNames,
  listMaterialFolders,
  moveMaterials,
  renameMaterial,
  renameMaterialFolder,
  type CreateMaterialFolderOutcome,
  type DeleteMaterialFolderOutcome,
  type DeleteMaterialOutcome,
  type LibraryFence,
  type MaterialFolder,
  type MoveMaterialsOutcome,
  type RenameMaterialFolderOutcome,
  type RenameMaterialOutcome,
} from '@/lib/persistence/material-library';

/** What a service operation needs from a persistence provider. */
export interface MaterialServicePersistence {
  pool: Queryable;
  withTransaction: WithTransaction;
}

/**
 * The agent's part of the library: everything it may do, and nothing that
 * deletes. The method shapes are the persistence operations' own
 * (`{ ownerId, ..., fence }`), minus the persistence the factory holds.
 */
export interface MaterialAgentService {
  listFolders(input: { ownerId: string; query?: string }): Promise<MaterialFolder[]>;
  listFolderNames(input: { ownerId: string }): Promise<Array<Pick<MaterialFolder, 'id' | 'name'>>>;
  createFolder(input: {
    ownerId: string;
    name: string;
    fence: LibraryFence;
  }): Promise<CreateMaterialFolderOutcome>;
  renameFolder(input: {
    ownerId: string;
    folderId: string;
    name: string;
    fence: LibraryFence;
  }): Promise<RenameMaterialFolderOutcome>;
  moveMaterials(input: {
    ownerId: string;
    materialIds: readonly string[];
    folderId: string | null;
    fence: LibraryFence;
  }): Promise<MoveMaterialsOutcome>;
  renameMaterial(input: {
    ownerId: string;
    materialId: string;
    name: string;
    fence: LibraryFence;
  }): Promise<RenameMaterialOutcome>;
}

/**
 * What the library page (and its HTTP routes) may do: the agent's operations
 * plus the two deletions. Deletion is the teacher's, never the model's.
 */
export interface MaterialAdminService extends MaterialAgentService {
  deleteMaterial(input: {
    ownerId: string;
    materialId: string;
    fence: 'request';
  }): Promise<DeleteMaterialOutcome>;
  deleteMaterialFolder(input: {
    ownerId: string;
    folderId: string;
    fence: LibraryFence;
  }): Promise<DeleteMaterialFolderOutcome>;
}

/** The operations the agent's tools may reach. Deletion is not on this object. */
export function createMaterialAgentService(
  persistence: MaterialServicePersistence,
): MaterialAgentService {
  return {
    listFolders: (input) =>
      listMaterialFolders(
        persistence.pool,
        input.ownerId,
        input.query === undefined ? {} : { query: input.query },
      ),
    listFolderNames: (input) => listMaterialFolderNames(persistence.pool, input.ownerId),
    createFolder: (input) => createMaterialFolder(persistence, input),
    renameFolder: (input) => renameMaterialFolder(persistence, input),
    moveMaterials: (input) => moveMaterials(persistence, input),
    renameMaterial: (input) => renameMaterial(persistence, input),
  };
}

/**
 * The operations the library page may reach: the same implementation the
 * agent gets, widened with deletion rather than reimplemented.
 */
export function createMaterialAdminService(
  persistence: MaterialServicePersistence,
): MaterialAdminService {
  return {
    ...createMaterialAgentService(persistence),
    deleteMaterial: (input) => deleteMaterial(persistence, input),
    deleteMaterialFolder: (input) => deleteMaterialFolder(persistence, input),
  };
}
