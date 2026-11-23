/**
 * 内存 MongoDB 替身（zero-dependency）
 * =============================================================
 *
 * 【为什么需要】
 * `scripts/test-workflows.js` 已经把 **Discord API 全部 mock 掉**了，
 * 但数据库是**真的 MongoDB** —— 于是：
 *   · 开发者本地没 MongoDB → `npm test` 直接抛
 *     `Missing required environment variable: MONGODB_URI`，**0 覆盖**
 *   · CI 必须先起一个 Mongo 实例
 *
 * 结果就是：**改坏了没人知道**。这个仓库最需要回归的地方
 * （权限判据、限流、campaign 冷却、退订）恰恰是最需要测试的地方。
 *
 * 【所以】
 * 让 `npm test` 在**零外部依赖**下跑通 —— 这也符合这个仓库
 * 「zero-dependency preview server」的既有风格。
 *
 * ⚠️ **这不是完整的 MongoDB 实现**，只覆盖本仓库用到的操作：
 *   findOne / find().sort().toArray() / insertOne / updateOne / updateMany /
 *   findOneAndUpdate / deleteOne / deleteMany / createIndex / dropIndex
 *
 * ⚠️ **不模拟**：聚合管道、事务、change streams、TTL 索引的真实行为、
 *   唯一索引的并发行为、地理查询。
 *   唯一索引只做**串行**检查（单进程内存，没有并发写）。
 *   TTL 索引（expireAfterSeconds）在内存里**不自动清理** ——
 *   需要时由测试自己删。真实 MongoDB 会自动删。
 *
 * 【怎么用】
 *   VALAX_DB_MODE=memory node scripts/test-workflows.js
 * 或让 `database.js` 在 `MONGODB_URI` 缺失时**自动**回落（默认行为）。
 */

import { randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/* 查询匹配                                                           */
/* ------------------------------------------------------------------ */

/**
 * 递归判断一个文档是否匹配一个 MongoDB 查询。
 *
 * 支持的操作符：
 *   等值            { a: 1 }
 *   $gt $gte $lt $lte $ne   { a: { $gt: 5 } }
 *   $in $nin       { a: { $in: [1,2] } }
 *   $exists        { a: { $exists: true } }
 *   $regex         { a: { $regex: "x", $options: "i" } }
 *   $or $and $nor  { $or: [ {...}, {...} ] }
 *   数组包含       { tags: "x" }  —— 字段是数组且包含该值
 *   点号路径       { "a.b": 1 }  —— 嵌套字段
 */
export function matches(document, query) {
  if (!query || typeof query !== "object") return true;

  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") {
      if (!Array.isArray(condition) || !condition.some((sub) => matches(document, sub))) return false;
      continue;
    }
    if (key === "$and") {
      if (!Array.isArray(condition) || !condition.every((sub) => matches(document, sub))) return false;
      continue;
    }
    if (key === "$nor") {
      if (Array.isArray(condition) && condition.some((sub) => matches(document, sub))) return false;
      continue;
    }

    const value = readPath(document, key);

    if (condition !== null && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (!matchesOperators(value, condition)) return false;
      continue;
    }

    if (!equals(value, condition)) return false;
  }
  return true;
}

function equals(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  if (Array.isArray(actual)) return actual.some((item) => equals(item, expected));
  return actual === expected;
}

function matchesOperators(value, operators) {
  for (const [op, operand] of Object.entries(operators)) {
    switch (op) {
      case "$eq":
        if (!equals(value, operand)) return false;
        break;
      case "$ne":
        if (equals(value, operand)) return false;
        break;
      case "$gt":
        if (!(value > operand)) return false;
        break;
      case "$gte":
        if (!(value >= operand)) return false;
        break;
      case "$lt":
        if (!(value < operand)) return false;
        break;
      case "$lte":
        if (!(value <= operand)) return false;
        break;
      case "$in":
        if (!Array.isArray(operand) || !operand.some((item) => equals(value, item))) return false;
        break;
      case "$nin":
        if (Array.isArray(operand) && operand.some((item) => equals(value, item))) return false;
        break;
      case "$exists": {
        const present = value !== undefined;
        if (operand === true && !present) return false;
        if (operand === false && present) return false;
        break;
      }
      case "$regex": {
        const pattern = operand instanceof RegExp ? operand : new RegExp(operand, operators.$options || "");
        if (typeof value !== "string" || !pattern.test(value)) return false;
        break;
      }
      case "$options":
        break; // 由 $regex 消费
      default:
        // 未知操作符 —— 保守地判为不匹配，避免「静默放行」
        return false;
    }
  }
  return true;
}

/** 读点号路径（`"a.b.c"`），不存在返回 undefined。 */
function readPath(document, path) {
  if (!path.includes(".")) return document?.[path];
  let current = document;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/** 写点号路径（自动建中间对象）。 */
function writePath(document, path, value) {
  const parts = path.split(".");
  let current = document;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/* ------------------------------------------------------------------ */
/* 更新操作符                                                         */
/* ------------------------------------------------------------------ */

/** 把 `$set` / `$unset` / `$inc` / `$setOnInsert` 应用到文档上。 */
function applyUpdate(document, update, { inserting = false } = {}) {
  const next = { ...document };

  for (const [op, payload] of Object.entries(update || {})) {
    switch (op) {
      case "$set":
        for (const [path, value] of Object.entries(payload || {})) {
          writePath(next, path, clone(value));
        }
        break;
      case "$unset":
        for (const path of Object.keys(payload || {})) {
          const parts = path.split(".");
          let current = next;
          for (let i = 0; i < parts.length - 1; i++) {
            current = current?.[parts[i]];
            if (current === undefined) break;
          }
          if (current && typeof current === "object") delete current[parts[parts.length - 1]];
        }
        break;
      case "$inc":
        for (const [path, delta] of Object.entries(payload || {})) {
          const current = readPath(next, path);
          writePath(next, path, (typeof current === "number" ? current : 0) + delta);
        }
        break;
      case "$setOnInsert":
        // 只在「插入」时生效 —— upsert 走这条
        if (inserting) {
          for (const [path, value] of Object.entries(payload || {})) {
            writePath(next, path, clone(value));
          }
        }
        break;
      case "$push":
        for (const [path, value] of Object.entries(payload || {})) {
          const current = readPath(next, path);
          const list = Array.isArray(current) ? [...current] : [];
          list.push(clone(value));
          writePath(next, path, list);
        }
        break;
      default:
        // 未知操作符 —— 抛，别静默忽略
        throw new Error(`memory-db: unsupported update operator "${op}"`);
    }
  }
  return next;
}

/** 深拷贝（结构化克隆；Date 保留）。 */
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clone(v);
  return out;
}

/* ------------------------------------------------------------------ */
/* 排序                                                               */
/* ------------------------------------------------------------------ */

/** 按 `{ field: 1 | -1 }` 排序（多字段）。 */
function sortDocuments(documents, sortSpec) {
  if (!sortSpec) return documents;
  const entries = Object.entries(sortSpec);
  return [...documents].sort((a, b) => {
    for (const [field, direction] of entries) {
      const av = readPath(a, field);
      const bv = readPath(b, field);
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      const cmp = av instanceof Date && bv instanceof Date
        ? av.getTime() - bv.getTime()
        : av < bv ? -1 : 1;
      return direction === -1 || direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

/* ------------------------------------------------------------------ */
/* Collection                                                         */
/* ------------------------------------------------------------------ */

class MemoryCursor {
  constructor(documents, options = {}) {
    this._documents = documents;
    this._sort = options.sort;
    this._limit = options.limit;
    this._skip = options.skip;
    this._project = options.projection;
  }

  sort(spec) {
    this._sort = spec;
    return this;
  }

  limit(count) {
    this._limit = count;
    return this;
  }

  skip(count) {
    this._skip = count;
    return this;
  }

  project(spec) {
    this._project = spec;
    return this;
  }

  async toArray() {
    let docs = sortDocuments(this._documents, this._sort);
    if (this._skip) docs = docs.slice(this._skip);
    if (this._limit != null) docs = docs.slice(0, this._limit);
    if (this._project) docs = docs.map((doc) => projectDocument(doc, this._project));
    return docs.map(clone);
  }

  async forEach(fn) {
    for (const doc of await this.toArray()) await fn(doc);
  }

  async *[Symbol.asyncIterator]() {
    for (const doc of await this.toArray()) yield doc;
  }
}

function projectDocument(document, projection) {
  const include = Object.entries(projection).filter(([, v]) => v === 1 || v === true);
  if (include.length === 0) return document;
  const out = { _id: document._id };
  for (const [field] of include) {
    const value = readPath(document, field);
    if (value !== undefined) writePath(out, field, value);
  }
  return out;
}

class MemoryCollection {
  constructor(name) {
    this.collectionName = name;
    this._documents = [];
    this._indexes = new Map();
    this._idCounter = 0;
  }

  async createIndex(spec, options = {}) {
    const key = Object.entries(spec).map(([field, dir]) => `${field}_${dir}`).join("_");
    this._indexes.set(key, { spec, ...options });
    return key;
  }

  async dropIndex(name) {
    if (!this._indexes.delete(name)) throw new Error(`index not found: ${name}`);
  }

  async indexes() {
    return [...this._indexes.entries()].map(([name, spec]) => ({ name, key: spec.spec }));
  }

  /** 唯一索引检查（**串行** —— 内存，没有并发写）。 */
  _assertUnique(indexName, document, excludeId) {
    const index = this._indexes.get(indexName);
    if (!index?.unique) return;
    const fields = Object.keys(index.spec);
    for (const other of this._documents) {
      if (other._id === document._id || other._id === excludeId) continue;
      const clash = fields.every((field) => equals(readPath(other, field), readPath(document, field)));
      if (clash) {
        throw new Error(
          `E11000 duplicate key error collection: ${this.collectionName} index: ${indexName} dup key: ` +
          `{ ${fields.map((f) => `${f}: ${JSON.stringify(readPath(document, f))}`).join(", ")} }`
        );
      }
    }
  }

  _nextId() {
    this._idCounter += 1;
    return `${this.collectionName}-${this._idCounter}`;
  }

  async insertOne(document) {
    const doc = clone(document) || {};
    if (doc._id === undefined) doc._id = this._nextId();
    for (const indexName of this._indexes.keys()) this._assertUnique(indexName, doc, null);
    this._documents.push(doc);
    return { acknowledged: true, insertedId: doc._id };
  }

  async insertMany(documents) {
    const ids = [];
    for (const doc of documents) ids.push((await this.insertOne(doc)).insertedId);
    return { acknowledged: true, insertedIds: ids };
  }

  /**
   * `find()` 返回一个**游标**（不是 Promise）——
   * MongoDB 的用法是 `collection.find(q).sort(s).toArray()`，
   * 游标必须能链式调用，所以这里不能是 async。
   */
  find(query = {}, options = {}) {
    const matched = this._documents.filter((doc) => matches(doc, query));
    return new MemoryCursor(matched, options);
  }

  async findOne(query = {}, options = {}) {
    const matched = this._documents.filter((doc) => matches(doc, query));
    const sorted = sortDocuments(matched, options.sort);
    const doc = sorted[0];
    if (!doc) return null;
    return options.projection ? projectDocument(doc, options.projection) : clone(doc);
  }

  async updateOne(query = {}, update = {}, options = {}) {
    const index = this._documents.findIndex((doc) => matches(doc, query));

    if (index === -1) {
      if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
      // upsert：用查询里的等值条件 + $setOnInsert 建文档
      const seed = {};
      for (const [key, value] of Object.entries(query)) {
        if (key.startsWith("$")) continue;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) continue;
        seed[key] = value;
      }
      const inserted = applyUpdate(seed, update, { inserting: true });
      if (inserted._id === undefined) inserted._id = this._nextId();
      for (const indexName of this._indexes.keys()) this._assertUnique(indexName, inserted, null);
      this._documents.push(inserted);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: inserted._id };
    }

    const before = this._documents[index];
    const after = applyUpdate(before, update);
    after._id = before._id;
    for (const indexName of this._indexes.keys()) this._assertUnique(indexName, after, before._id);
    this._documents[index] = after;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  async updateMany(query = {}, update = {}, options = {}) {
    let modified = 0;
    for (let i = 0; i < this._documents.length; i++) {
      if (!matches(this._documents[i], query)) continue;
      const before = this._documents[i];
      const after = applyUpdate(before, update);
      after._id = before._id;
      for (const indexName of this._indexes.keys()) this._assertUnique(indexName, after, before._id);
      this._documents[i] = after;
      modified += 1;
    }
    return { acknowledged: true, matchedCount: modified, modifiedCount: modified, upsertedId: null };
  }

  async findOneAndUpdate(query = {}, update = {}, options = {}) {
    const index = this._documents.findIndex((doc) => matches(doc, query));

    if (index === -1) {
      if (!options.upsert) return null;
      const seed = {};
      for (const [key, value] of Object.entries(query)) {
        if (key.startsWith("$")) continue;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) continue;
        seed[key] = value;
      }
      const inserted = applyUpdate(seed, update, { inserting: true });
      if (inserted._id === undefined) inserted._id = this._nextId();
      for (const indexName of this._indexes.keys()) this._assertUnique(indexName, inserted, null);
      this._documents.push(inserted);
      return clone(inserted);
    }

    const before = this._documents[index];
    const after = applyUpdate(before, update);
    after._id = before._id;
    for (const indexName of this._indexes.keys()) this._assertUnique(indexName, after, before._id);
    this._documents[index] = after;
    return clone(after);
  }

  async deleteOne(query = {}) {
    const index = this._documents.findIndex((doc) => matches(doc, query));
    if (index === -1) return { acknowledged: true, deletedCount: 0 };
    this._documents.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(query = {}) {
    const before = this._documents.length;
    this._documents = this._documents.filter((doc) => !matches(doc, query));
    return { acknowledged: true, deletedCount: before - this._documents.length };
  }

  async countDocuments(query = {}) {
    return this._documents.filter((doc) => matches(doc, query)).length;
  }

  async estimatedDocumentCount() {
    return this._documents.length;
  }

  async aggregate() {
    throw new Error("memory-db: aggregation pipeline is not supported");
  }

  async distinct(field) {
    const values = new Set();
    for (const doc of this._documents) {
      const value = readPath(doc, field);
      if (value !== undefined) values.add(value);
    }
    return [...values];
  }
}

/* ------------------------------------------------------------------ */
/* Database                                                           */
/* ------------------------------------------------------------------ */

export class MemoryDatabase {
  constructor() {
    this._collections = new Map();
  }

  collection(name) {
    if (!this._collections.has(name)) this._collections.set(name, new MemoryCollection(name));
    return this._collections.get(name);
  }

  listCollections() {
    return { toArray: async () => [...this._collections.values()].map((c) => ({ name: c.collectionName })) };
  }

  /**
   * 健康检查用的 ping。
   *
   * ⚠️ 真 MongoDB 有 `db.command({ ping: 1 })` —— 内存替身必须也支持，
   *    否则 `/api/health` 在内存模式下会 503，**看起来像数据库挂了**。
   */
  async command(command = {}) {
    if (command && typeof command === "object" && "ping" in command) {
      return { ok: 1 };
    }
    throw new Error(`memory-db: unsupported command ${JSON.stringify(command)}`);
  }

  /** 清空全部数据（测试之间隔离用）。 */
  async reset() {
    this._collections.clear();
  }
}

/**
 * 建一个内存数据库实例。
 * @param {string} name 数据库名（仅为兼容签名）
 */
export function createMemoryDatabase(name = "valax") {
  return new MemoryDatabase();
}
