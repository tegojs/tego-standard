var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var server_exports = {};
__export(server_exports, {
  default: () => PluginActionLogs
});
module.exports = __toCommonJS(server_exports);
var import_node_path = __toESM(require("node:path"));
var import_node_worker_threads = require("node:worker_threads");
var import_server = require("@tego/server");
var import_hooks = require("./hooks");
var import_security_event_listener = require("./security-event-listener");
class PluginActionLogs extends import_server.Plugin {
  constructor() {
    super(...arguments);
    this.logsBuffer = [];
    // 用于存储消息的缓冲区
    this.logsTimer = null;
    this.logsDebounce = 500;
  }
  async afterAdd() {
    if (!import_node_worker_threads.isMainThread) {
      this.addAuditListener();
    }
    (0, import_security_event_listener.registerSecurityEventListener)(this);
  }
  async beforeLoad() {
    if (import_node_worker_threads.isMainThread) {
      this.addAuditListener();
    }
    this.app.on("beforeDestroy", async () => {
      if (this.logsTimer) {
        clearTimeout(this.logsTimer);
        this.logsTimer = null;
      }
      if (this.logsBuffer.length > 0) {
        const pending = [...this.logsBuffer];
        this.logsBuffer = [];
        try {
          await this.workerCreateAuditLog(pending);
        } catch {
        }
      }
    });
  }
  async addAuditListener() {
    this.db.on("afterCreate", (model, options) => {
      (0, import_hooks.afterCreate)(model, options, this);
    });
    this.db.on("afterUpdate", (model, options) => {
      (0, import_hooks.afterUpdate)(model, options, this);
    });
    this.db.on("afterDestroy", (model, options) => {
      (0, import_hooks.afterDestroy)(model, options, this);
    });
  }
  async load() {
    this.db.addMigrations({
      namespace: "audit-logs",
      directory: import_node_path.default.resolve(__dirname, "./migrations"),
      context: {
        plugin: this
      }
    });
    this.app.acl.allow("auditLogs", ["list", "get"], "loggedIn");
    this.app.acl.allow("auditChanges", ["get"], "loggedIn");
  }
  async handleSyncMessage(message) {
    if ((message == null ? void 0 : message.type) === "auditLog") {
      this.logsBuffer.push(message.values);
      if (this.logsTimer) return;
      this.logsTimer = setTimeout(() => {
        const targetList = [...this.logsBuffer];
        this.logsTimer = null;
        if (!targetList.length) {
          return;
        }
        this.logsBuffer = [];
        this.handleBatchLogs(targetList);
      }, this.logsDebounce);
    }
  }
  async handleBatchLogs(values, transaction) {
    var _a;
    if (!import_node_worker_threads.isMainThread || !((_a = this.app.worker) == null ? void 0 : _a.available)) {
      await this.workerCreateAuditLog(values);
    } else {
      await this.app.worker.callPluginMethod({
        plugin: this.name,
        method: "workerCreateAuditLog",
        params: values,
        reloadCols: false,
        inputLog: {
          length: values.length
        }
      });
    }
  }
  async workerCreateAuditLog(values, transaction) {
    const auditLogRepo = this.db.getRepository("auditLogs");
    const auditChangeRepo = this.db.getRepository("auditChanges");
    const now = /* @__PURE__ */ new Date();
    values.forEach((value) => value.createdAt = now);
    const insertedLogs = await auditLogRepo.model.bulkCreate(values, {
      individualHooks: false,
      // 禁用逐条钩子调用
      transaction,
      // 使用事务
      returning: ["id"]
      // 仅返回 id 字段
    });
    const changes = [];
    insertedLogs.forEach((log, index) => {
      const value = values[index];
      if (!value.changes) {
        return;
      }
      for (const change of value.changes) {
        changes.push({
          ...change,
          auditLogId: log.id
        });
      }
    });
    if (changes.length > 0) {
      await auditChangeRepo.model.bulkCreate(changes, {
        individualHooks: false,
        // 禁用逐条钩子调用
        transaction
        // 使用事务
      });
    }
  }
}
